// Organizer invoice export.
//
// The organizers are the sellers of the tickets, so the invoices for the ticket
// part of every order are theirs; we prepare them monthly and the organizers'
// accountants import the CSV (the .txt is the printable copy). One line per
// paid order: net, VAT 27%, gross. Our service fee is NOT on these, we invoice
// that ourselves.
//
// Copied from the payout report and adjusted, keep the two in sync.
import fs from "fs";
import path from "path";
import { getDb, type Db } from "../db/client";

const VAT_RATE = 0.27;

interface Organizer {
  name: string;
  email: string;
  taxNo: string;
}

// organizers by venue (copy of the list in payouts.ts, TB-212)
const ORGANIZERS: Record<string, Organizer> = {
  "Budapest Park": { name: "Park Live Events Kft.", email: "finance@parklive.example", taxNo: "12345678-2-42" },
  "Zamárdi Beach": { name: "Lakeside Festivals Kft.", email: "accounts@lakeside-fest.example", taxNo: "23456789-2-14" },
  "Hungexpo Hall G": { name: "CraftConf Szervező Kft.", email: "billing@craftconf.example", taxNo: "34567890-2-41" },
  "MVM Dome": { name: "Dome Arena Productions Zrt.", email: "settlements@domearena.example", taxNo: "45678901-2-43" },
  "Kisüzem": { name: "Kisüzem Kulturális Egyesület", email: "hello@kisuzem.example", taxNo: "18765432-1-42" },
  "A38 Ship": { name: "Danube Stage Kft.", email: "finance@danubestage.example", taxNo: "56789012-2-43" },
  "Opus Jazz Club": { name: "Opus Music Kft.", email: "office@opusmusic.example", taxNo: "67890123-2-42" },
};

/** A venue not in the table is invoiced under its own name, to our own invoices inbox. */
function organizerFor(venue: string): Organizer {
  if (Object.hasOwn(ORGANIZERS, venue)) return ORGANIZERS[venue]!;
  return { name: venue, email: "invoices@ticketbay.example", taxNo: "" };
}

// running invoice number, continues where the last export stopped (in this process)
let invoiceSeq = 1;
const moduleSequence = { next: () => invoiceSeq++ };

export let lastInvoiceExport: InvoiceExport | null = null;

/** What the export runs on; every field defaults to the app's own (the shared pool, the wall clock, ./reports, the running number). */
export interface InvoiceExportDeps {
  db: Db;
  /** "now": the default month, the generated-at stamps and the mail dates */
  nowMs: number;
  /** the folder the CSV, the printable copy and the outbox log go to */
  dir: string;
  /** the running invoice number */
  sequence: { next(): number };
}

export interface InvoiceExportParams {
  /** "2027-01" or "2027-1"; nothing means the clock's month */
  month?: string | null;
  /** one event's orders only */
  event?: string | null;
}

export interface InvoiceLine {
  invoiceNo: string;
  orderId: number;
  orderNumber: string;
  /** YYYY-MM-DD, UTC */
  date: string;
  customer: string;
  customerEmail: string;
  eventId: string;
  eventName: string;
  tickets: number;
  discountPercent: number;
  netCents: number;
  vatCents: number;
  grossCents: number;
}

/** One seller's invoices of the month and their sums. */
export interface OrganizerBlock {
  organizer: string;
  email: string;
  taxNo: string;
  lines: InvoiceLine[];
  netCents: number;
  vatCents: number;
  grossCents: number;
}

export interface InvoiceExport {
  batchId: string;
  /** YYYY-MM */
  month: string;
  generatedAt: string;
  organizers: OrganizerBlock[];
  totals: { invoices: number; netCents: number; vatCents: number; grossCents: number };
  /** the CSV and the printable copy, relative to the working directory */
  files: string[];
  emailsSent: number;
}

/** A paid order joined with its event, as the query returns it (BIGINT columns arrive as strings). */
interface PaidOrderRow {
  id: number;
  event_id: string;
  event_name: string;
  venue: string;
  customer_name: string;
  customer_email: string;
  quantity: number;
  subtotal_cents: string | number;
  discount_cents: string | number;
  tickets_cents: string | number;
  created_at_ms: string | number;
}

function withDefaults(partial: Partial<InvoiceExportDeps>): InvoiceExportDeps {
  return {
    db: partial.db ?? getDb(),
    nowMs: partial.nowMs ?? Date.now(),
    dir: partial.dir ?? path.join(process.cwd(), "reports"),
    sequence: partial.sequence ?? moduleSequence,
  };
}

// ---- The month ----------------------------------------------------------------

/** The export window: the month as given ("2027-01", "2027-1") or the clock's local month; [start, end) in UTC. */
function monthWindow(month: string | null | undefined, nowMs: number): { label: string; start: Date; end: Date } {
  let label = month;
  if (!label) {
    const d = new Date(nowMs);
    label = d.getFullYear() + "-" + (d.getMonth() + 1);
  }
  const parts = label.split("-");
  const y = parseInt(parts[0]!);
  const m = parseInt(parts[1]!);
  return { label, start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

// ---- The orders ---------------------------------------------------------------

/** The paid orders of the window, one event's or all, by venue then by id. */
async function loadPaidOrders(db: Db, start: Date, end: Date, event: string | null | undefined): Promise<PaidOrderRow[]> {
  let sql =
    "SELECT o.*, e.name AS event_name, e.venue AS venue FROM orders o JOIN events e ON e.id = o.event_id " +
    "WHERE o.status = 'paid' AND o.created_at_ms >= $1 AND o.created_at_ms < $2";
  const args: (number | string)[] = [start.getTime(), end.getTime()];
  if (event) {
    sql += " AND o.event_id = $3";
    args.push(event);
  }
  sql += " ORDER BY e.venue, o.id";
  const res = await db.$client.query(sql, args);
  return res.rows as PaidOrderRow[];
}

// ---- The money ----------------------------------------------------------------

/** The VAT 27% that is in a gross amount, and the net that remains. */
function splitVat(grossCents: number): { netCents: number; vatCents: number } {
  const grossEur = grossCents / 100;
  const netEur = grossEur / (1 + VAT_RATE);
  const vatCents = Math.round((grossEur - netEur) * 100);
  return { netCents: grossCents - vatCents, vatCents };
}

/** One invoice: the order's tickets amount is the gross (the service fee is ours, not on it). */
function invoiceLine(o: PaidOrderRow, invoiceNo: string): InvoiceLine {
  const grossCents = Number(o.tickets_cents);
  const { netCents, vatCents } = splitVat(grossCents);
  return {
    invoiceNo,
    orderId: o.id,
    orderNumber: "TB-" + String(o.id).padStart(5, "0"),
    date: new Date(Number(o.created_at_ms)).toISOString().substring(0, 10),
    customer: o.customer_name,
    customerEmail: o.customer_email,
    eventId: o.event_id,
    eventName: o.event_name,
    tickets: o.quantity,
    discountPercent: Math.round((Number(o.discount_cents) / Number(o.subtotal_cents)) * 100),
    netCents,
    vatCents,
    grossCents,
  };
}

/** One block per organizer, in the order the rows come (by venue); the lines numbered from the running number. */
function groupByOrganizer(rows: PaidOrderRow[], ym: string, sequence: { next(): number }): OrganizerBlock[] {
  const blocks: OrganizerBlock[] = [];
  const byName = new Map<string, OrganizerBlock>();
  for (const o of rows) {
    const org = organizerFor(o.venue);
    let block = byName.get(org.name);
    if (!block) {
      block = { organizer: org.name, email: org.email, taxNo: org.taxNo, lines: [], netCents: 0, vatCents: 0, grossCents: 0 };
      byName.set(org.name, block);
      blocks.push(block);
    }
    const invoiceNo = "TB-" + ym.replace("-", "") + "-" + String(sequence.next()).padStart(6, "0");
    const line = invoiceLine(o, invoiceNo);
    block.lines.push(line);
    block.netCents += line.netCents;
    block.vatCents += line.vatCents;
    block.grossCents += line.grossCents;
  }
  return blocks;
}

function sumOf(blocks: OrganizerBlock[]): { netCents: number; vatCents: number; grossCents: number } {
  let netCents = 0;
  let vatCents = 0;
  let grossCents = 0;
  for (const b of blocks) {
    netCents += b.netCents;
    vatCents += b.vatCents;
    grossCents += b.grossCents;
  }
  return { netCents, vatCents, grossCents };
}

// ---- The CSV ------------------------------------------------------------------

const CSV_HEADER = "batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate\n";

const eur = (cents: number) => (cents / 100).toFixed(2);

/** A CSV field: quoted when it holds a comma, a quote or a line break. */
function q(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return '"' + s.split('"').join('""') + '"';
  return s;
}

/** The CSV the accountants import: one line per invoice. */
function renderCsv(batchId: string, blocks: OrganizerBlock[]): string {
  let csv = CSV_HEADER;
  for (const g of blocks) {
    for (const l of g.lines) {
      csv +=
        [batchId, l.invoiceNo, l.orderNumber, l.date, q(g.organizer), q(g.taxNo), q(l.customer), q(l.eventName), l.tickets, l.discountPercent, eur(l.netCents), eur(l.vatCents), eur(l.grossCents), "27%"].join(",") +
        "\n";
    }
  }
  return csv;
}

// ---- The printable copy -------------------------------------------------------

const RULE = "=".repeat(96);
const THIN_RULE = "-".repeat(96);

/** An amount right-aligned in a fixed-width column. */
function col(eur: number, width: number): string {
  const s = eur.toFixed(2);
  return " ".repeat(Math.max(width - s.length, 0)) + s;
}

/** Text left-aligned in a fixed-width column, cut with an ellipsis when longer. */
function left(s: string, width: number): string {
  if (s.length > width) return s.substring(0, width - 1) + "…";
  return s + " ".repeat(width - s.length);
}

/** The three amount columns of a line or a total. */
function amounts(x: { netCents: number; vatCents: number; grossCents: number }): string {
  return col(x.netCents / 100, 12) + col(x.vatCents / 100, 12) + col(x.grossCents / 100, 12);
}

/** The printable copy: one block per organizer. */
function renderTxt(label: string, batchId: string, generatedAt: string, blocks: OrganizerBlock[]): string {
  let txt = "TICKETBAY - ORGANIZER INVOICES " + label + "\nBatch " + batchId + "   generated " + generatedAt + "\n\n";
  for (const g of blocks) {
    txt += RULE + "\n";
    txt += "Seller: " + g.organizer + (g.taxNo ? "  (tax no. " + g.taxNo + ")" : "") + "\n";
    txt += RULE + "\n";
    txt += left("Invoice", 20) + left("Order", 10) + left("Customer", 24) + left("Qty", 5) + "         Net" + "         VAT" + "       Gross\n";
    for (const l of g.lines) {
      txt += left(l.invoiceNo, 20) + left(l.orderNumber, 10) + left(l.customer, 24) + left(String(l.tickets), 5) + amounts(l) + "\n";
    }
    txt += THIN_RULE + "\n";
    txt += left("Total", 59) + amounts(g) + "\n";
    txt += "VAT 27% included in the gross amounts.\n\n";
  }
  return txt;
}

// ---- The files and the mails --------------------------------------------------

/** Writes the CSV and the printable copy; returns their paths. */
function writeFiles(dir: string, ym: string, csv: string, txt: string): string[] {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const csvFile = path.join(dir, "invoices-" + ym + ".csv");
  const txtFile = path.join(dir, "invoices-" + ym + ".txt");
  fs.writeFileSync(csvFile, csv);
  fs.writeFileSync(txtFile, txt);
  console.log("[invoices] wrote " + csvFile + " and " + txtFile);
  return [csvFile, txtFile];
}

/** What an organizer gets: its counts, its sums, its first and last invoice number. */
function mailBody(g: OrganizerBlock, label: string): string {
  return (
    "Dear " + g.organizer + ",\n\nattached are the ticket invoices TicketBay issued in your name for " + label + ".\n\n" +
    "  invoices:  " + g.lines.length + "\n" +
    "  net:       " + col(g.netCents / 100, 12) + " EUR\n" +
    "  VAT 27%:   " + col(g.vatCents / 100, 12) + " EUR\n" +
    "  gross:     " + col(g.grossCents / 100, 12) + " EUR\n\n" +
    "First invoice: " + g.lines[0]!.invoiceNo + ", last invoice: " + g.lines[g.lines.length - 1]!.invoiceNo + "\n" +
    "\nThanks,\nTicketBay Finance\n"
  );
}

// same fake transport as the payout report, the accountants read the outbox file
function sendMail(deps: InvoiceExportDeps, to: string, subject: string, body: string): void {
  console.log("[invoices] mail -> " + to + " (" + subject + ")");
  try {
    fs.mkdirSync(deps.dir, { recursive: true });
    fs.appendFileSync(
      path.join(deps.dir, "outbox.log"),
      "To: " + to + "\nSubject: " + subject + "\nDate: " + new Date(deps.nowMs).toUTCString() + "\n\n" + body + "\n-----\n",
    );
  } catch (e) {
    console.log("[invoices] could not write outbox", e);
  }
}

// ---- The export ---------------------------------------------------------------

export async function invoiceExport(params: InvoiceExportParams, partial: Partial<InvoiceExportDeps> = {}): Promise<InvoiceExport> {
  const deps = withDefaults(partial);
  const { label, start, end } = monthWindow(params.month, deps.nowMs);
  console.log("[invoices] export " + label + " (" + start.toISOString() + " - " + end.toISOString() + ") event=" + params.event);
  const ym = start.toISOString().substring(0, 7);

  const rows = await loadPaidOrders(deps.db, start, end, params.event);
  console.log("[invoices] " + rows.length + " paid orders");

  // batch id: the month plus the first order in it (0 when there is none), so finance can tell exports apart
  const batchId = "INV-" + ym + "-" + (rows.length > 0 ? rows[0]!.id : 0);
  const blocks = groupByOrganizer(rows, ym, deps.sequence);
  const generatedAt = new Date(deps.nowMs).toISOString();

  const files = writeFiles(deps.dir, ym, renderCsv(batchId, blocks), renderTxt(label, batchId, generatedAt, blocks));

  // every organizer gets its own block of the printable copy
  for (const g of blocks) sendMail(deps, g.email, "TicketBay invoices " + label + " (" + batchId + ")", mailBody(g, label));

  const result: InvoiceExport = {
    batchId,
    month: ym,
    generatedAt,
    organizers: blocks,
    totals: { invoices: rows.length, ...sumOf(blocks) },
    files: files.map((f) => path.relative(process.cwd(), f)),
    emailsSent: blocks.length,
  };
  lastInvoiceExport = result;
  return result;
}
