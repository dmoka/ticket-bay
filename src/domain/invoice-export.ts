// Organizer invoice export, the pure part: paid order rows in, the export out
// (JSON result, the accountants' CSV, the printable copy, one mail per
// organizer). No database, no files, no mail, no wall clock: the shell in
// src/finance/invoices.ts does those and calls this.
//
// The organizers are the sellers of the tickets, so the invoices for the ticket
// part of every order are theirs. One line per paid order: net, VAT 27%,
// gross. Our service fee is NOT on these, we invoice that ourselves.

const VAT_RATE = 0.27;

/** One paid order as the export query returns it (BIGINT columns arrive as strings). */
export interface InvoiceOrderRow {
  id: number;
  event_id: string;
  event_name: string;
  venue: string;
  customer_name: string;
  customer_email: string;
  quantity: number;
  subtotal_cents: number | string;
  discount_cents: number | string;
  tickets_cents: number | string;
  created_at_ms: number | string;
}

interface Organizer {
  name: string;
  email: string;
  taxNo: string;
}

/** One invoice: the ticket part of one paid order. */
export interface InvoiceLine {
  invoiceNo: string;
  orderId: number;
  orderNumber: string;
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

/** One organizer's invoices and their totals. */
export interface OrganizerInvoices {
  organizer: string;
  email: string;
  taxNo: string;
  lines: InvoiceLine[];
  netCents: number;
  vatCents: number;
  grossCents: number;
}

export interface InvoiceExportInput {
  rows: InvoiceOrderRow[];
  /** the month as asked for, printed as is in the headings */
  month: string;
  /** when the export runs */
  now: Date;
  /** the running invoice number: called once per line, in line order */
  nextInvoiceSeq: () => number;
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

function organizerFor(venue: string): Organizer {
  return ORGANIZERS[venue] || { name: venue, email: "invoices@ticketbay.example", taxNo: "" };
}

/** The UTC month `month` ("YYYY-MM") names: [start, end). */
export function invoiceMonth(month: string): { start: Date; end: Date } {
  const parts = month.split("-");
  const y = parseInt(parts[0]!);
  const m = parseInt(parts[1]!);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/** The ticket amount (VAT included) split into net and VAT, in cents. */
function splitVat(ticketsCents: number | string): { netCents: number; vatCents: number; grossCents: number } {
  const grossEur = parseFloat(String(ticketsCents)) / 100;
  const vatCents = Math.round((grossEur - grossEur / (1 + VAT_RATE)) * 100);
  const grossCents = Number(ticketsCents);
  return { netCents: grossCents - vatCents, vatCents, grossCents };
}

function invoiceLine(o: InvoiceOrderRow, invoiceNo: string): InvoiceLine {
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
    ...splitVat(o.tickets_cents),
  };
}

type Amounts = Pick<InvoiceLine, "netCents" | "vatCents" | "grossCents">;

function addTo(total: Amounts, l: Amounts) {
  total.netCents += l.netCents;
  total.vatCents += l.vatCents;
  total.grossCents += l.grossCents;
}

const euros = (cents: number) => (cents / 100).toFixed(2);

// ---- The documents ----------------------------------------------------------

// right-align an amount in a fixed-width column of the printable invoice
function col(cents: number, width = 12) {
  const eur = cents / 100;
  const digits = Math.floor(Math.log10(eur)) + 1;
  const pad = Math.max(width - digits - 3, 0);
  return " ".repeat(pad) + eur.toFixed(2);
}

function left(s: string, width: number) {
  if (s.length > width) return s.substring(0, width - 1) + "…";
  return s + " ".repeat(width - s.length);
}

function q(value: string | number) {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return '"' + s.split('"').join('""') + '"';
  return s;
}

const CSV_HEADER = "batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate\n";

/** The accountants' CSV: one record per line, organizer by organizer. */
function csvOf(batchId: string, groups: OrganizerInvoices[]) {
  let csv = CSV_HEADER;
  for (const g of groups) {
    for (const l of g.lines) {
      csv +=
        batchId + "," + l.invoiceNo + "," + l.orderNumber + "," + l.date + "," + q(g.organizer) + "," + q(g.taxNo) + "," +
        q(l.customer) + "," + q(l.eventName) + "," + l.tickets + "," + l.discountPercent + "," +
        euros(l.netCents) + "," + euros(l.vatCents) + "," + euros(l.grossCents) + ",27%\n";
    }
  }
  return csv;
}

const amountCols = (a: Amounts) => col(a.netCents) + col(a.vatCents) + col(a.grossCents);

/** The printable copy: a heading, then one block per organizer. */
function printableOf(month: string, batchId: string, now: Date, groups: OrganizerInvoices[]) {
  const rule = "=".repeat(96) + "\n";
  let txt = "TICKETBAY - ORGANIZER INVOICES " + month + "\nBatch " + batchId + "   generated " + now.toISOString() + "\n\n";
  for (const g of groups) {
    txt += rule + "Seller: " + g.organizer + (g.taxNo ? "  (tax no. " + g.taxNo + ")" : "") + "\n" + rule;
    txt += left("Invoice", 20) + left("Order", 10) + left("Customer", 24) + left("Qty", 5) + "         Net" + "         VAT" + "       Gross\n";
    for (const l of g.lines) {
      txt += left(l.invoiceNo, 20) + left(l.orderNumber, 10) + left(l.customer, 24) + left(String(l.tickets), 5) + amountCols(l) + "\n";
    }
    txt += "-".repeat(96) + "\n";
    txt += left("Total", 59) + amountCols(g) + "\n";
    txt += "VAT 27% included in the gross amounts.\n\n";
  }
  return txt;
}

/** The summary mail an organizer gets with its invoices. */
function mailOf(month: string, batchId: string, g: OrganizerInvoices) {
  const body =
    "Dear " + g.organizer + ",\n\nattached are the ticket invoices TicketBay issued in your name for " + month + ".\n\n" +
    "  invoices:  " + g.lines.length + "\n" +
    "  net:       " + col(g.netCents) + " EUR\n" +
    "  VAT 27%:   " + col(g.vatCents) + " EUR\n" +
    "  gross:     " + col(g.grossCents) + " EUR\n\n" +
    "First invoice: " + g.lines[0]!.invoiceNo + ", last invoice: " + g.lines[g.lines.length - 1]!.invoiceNo + "\n" +
    "\nThanks,\nTicketBay Finance\n";
  return { to: g.email, subject: "TicketBay invoices " + month + " (" + batchId + ")", body };
}

// ---- The export -------------------------------------------------------------

/** The export: the JSON result (without `files`), the CSV, the printable copy and the mails. */
export function buildInvoiceExport({ rows, month, now, nextInvoiceSeq }: InvoiceExportInput) {
  const monthKey = invoiceMonth(month).start.toISOString().substring(0, 7);

  // batch id: the month plus the first order in it, so finance can tell exports apart
  const batchId = "INV-" + monthKey + "-" + rows[0]!.id;

  // a plain object keyed by organizer name, groups in the order they first appear
  const byName: Record<string, OrganizerInvoices> = {};
  const groups: OrganizerInvoices[] = [];
  const totals: Amounts = { netCents: 0, vatCents: 0, grossCents: 0 };

  for (const o of rows) {
    const org = organizerFor(o.venue);
    let g = byName[org.name];
    if (!g) {
      g = byName[org.name] = { organizer: org.name, email: org.email, taxNo: org.taxNo, lines: [], netCents: 0, vatCents: 0, grossCents: 0 };
      groups.push(g);
    }
    const line = invoiceLine(o, "TB-" + monthKey.replace("-", "") + "-" + String(nextInvoiceSeq()).padStart(6, "0"));
    g.lines.push(line);
    addTo(g, line);
    addTo(totals, line);
  }

  return {
    result: {
      batchId,
      month: monthKey,
      generatedAt: now.toISOString(),
      organizers: groups,
      totals: { invoices: rows.length, ...totals },
    },
    csv: csvOf(batchId, groups),
    txt: printableOf(month, batchId, now, groups),
    mails: groups.map((g) => mailOf(month, batchId, g)),
  };
}
