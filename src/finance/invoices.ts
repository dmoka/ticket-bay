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
import { getDb } from "../db/client";

const VAT_RATE = 0.27;

// organizers by venue (copy of the list in payouts.ts, TB-212)
const ORGANIZERS: any = {
  "Budapest Park": { name: "Park Live Events Kft.", email: "finance@parklive.example", taxNo: "12345678-2-42" },
  "Zamárdi Beach": { name: "Lakeside Festivals Kft.", email: "accounts@lakeside-fest.example", taxNo: "23456789-2-14" },
  "Hungexpo Hall G": { name: "CraftConf Szervező Kft.", email: "billing@craftconf.example", taxNo: "34567890-2-41" },
  "MVM Dome": { name: "Dome Arena Productions Zrt.", email: "settlements@domearena.example", taxNo: "45678901-2-43" },
  "Kisüzem": { name: "Kisüzem Kulturális Egyesület", email: "hello@kisuzem.example", taxNo: "18765432-1-42" },
  "A38 Ship": { name: "Danube Stage Kft.", email: "finance@danubestage.example", taxNo: "56789012-2-43" },
  "Opus Jazz Club": { name: "Opus Music Kft.", email: "office@opusmusic.example", taxNo: "67890123-2-42" },
};

// running invoice number, continues where the last export stopped
let invoiceSeq = 1;
export let lastInvoiceExport: any = null;

function organizerFor(venue: string) {
  const o = ORGANIZERS[venue];
  if (o) return o;
  return { name: venue, email: "invoices@ticketbay.example", taxNo: "" };
}

// same fake transport as the payout report, the accountants read the outbox file
function sendMail(to: string, subject: string, body: string) {
  console.log("[invoices] mail -> " + to + " (" + subject + ")");
  try {
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.appendFileSync(
      path.join(process.cwd(), "reports", "outbox.log"),
      "To: " + to + "\nSubject: " + subject + "\nDate: " + new Date().toUTCString() + "\n\n" + body + "\n-----\n",
    );
  } catch (e) {
    console.log("[invoices] could not write outbox", e);
  }
}

// right-align an amount in a fixed-width column of the printable invoice
function col(eur: number, width: number) {
  const digits = Math.floor(Math.log10(eur)) + 1;
  const pad = Math.max(width - digits - 3, 0);
  return " ".repeat(pad) + eur.toFixed(2);
}

function left(s: string, width: number) {
  if (s.length > width) return s.substring(0, width - 1) + "…";
  return s + " ".repeat(width - s.length);
}

function q(s: any) {
  s = String(s);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return '"' + s.split('"').join('""') + '"';
  return s;
}

export async function invoiceExport(params: any) {
  const db = getDb();

  let month = params.month;
  if (!month) {
    const d = new Date();
    month = d.getFullYear() + "-" + (d.getMonth() + 1);
  }
  const parts = month.split("-");
  const y = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  console.log("[invoices] export " + month + " (" + start.toISOString() + " - " + end.toISOString() + ") event=" + params.event);

  let sql =
    "SELECT o.*, e.name AS event_name, e.venue AS venue FROM orders o JOIN events e ON e.id = o.event_id " +
    "WHERE o.status = 'paid' AND o.created_at_ms >= $1 AND o.created_at_ms < $2";
  const args: any[] = [start.getTime(), end.getTime()];
  if (params.event) {
    sql += " AND o.event_id = $3";
    args.push(params.event);
  }
  sql += " ORDER BY e.venue, o.id";
  const res = await db.$client.query(sql, args);
  const rows = res.rows;
  console.log("[invoices] " + rows.length + " paid orders");

  // batch id: the month plus the first order in it, so finance can tell exports apart
  const batchId = "INV-" + start.toISOString().substring(0, 7) + "-" + rows[0].id;

  const groups: any = {};
  const order: string[] = [];
  let totalNet = 0;
  let totalVat = 0;
  let totalGross = 0;

  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    const org = organizerFor(o.venue);
    if (!groups[org.name]) {
      groups[org.name] = { organizer: org.name, email: org.email, taxNo: org.taxNo, lines: [], netCents: 0, vatCents: 0, grossCents: 0 };
      order.push(org.name);
    }
    const g = groups[org.name];

    const grossEur = parseFloat(o.tickets_cents) / 100;
    const netEur = grossEur / (1 + VAT_RATE);
    const vatCents = Math.round((grossEur - netEur) * 100);
    const grossCents = Number(o.tickets_cents);
    const netCents = grossCents - vatCents;
    const discountPct = Math.round((Number(o.discount_cents) / Number(o.subtotal_cents)) * 100);

    const invoiceNo = "TB-" + start.toISOString().substring(0, 7).replace("-", "") + "-" + String(invoiceSeq++).padStart(6, "0");
    g.lines.push({
      invoiceNo: invoiceNo,
      orderId: o.id,
      orderNumber: "TB-" + String(o.id).padStart(5, "0"),
      date: new Date(Number(o.created_at_ms)).toISOString().substring(0, 10),
      customer: o.customer_name,
      customerEmail: o.customer_email,
      eventId: o.event_id,
      eventName: o.event_name,
      tickets: o.quantity,
      discountPercent: discountPct,
      netCents: netCents,
      vatCents: vatCents,
      grossCents: grossCents,
    });
    g.netCents += netCents;
    g.vatCents += vatCents;
    g.grossCents += grossCents;
    totalNet += netCents;
    totalVat += vatCents;
    totalGross += grossCents;
  }

  // CSV for the accountants
  let csv = "batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate\n";
  for (let i = 0; i < order.length; i++) {
    const g = groups[order[i]];
    for (let j = 0; j < g.lines.length; j++) {
      const l = g.lines[j];
      csv +=
        batchId + "," + l.invoiceNo + "," + l.orderNumber + "," + l.date + "," + q(g.organizer) + "," + q(g.taxNo) + "," +
        q(l.customer) + "," + q(l.eventName) + "," + l.tickets + "," + l.discountPercent + "," +
        (l.netCents / 100).toFixed(2) + "," + (l.vatCents / 100).toFixed(2) + "," + (l.grossCents / 100).toFixed(2) + ",27%\n";
    }
  }

  // printable copy, one block per organizer
  let txt = "TICKETBAY - ORGANIZER INVOICES " + month + "\nBatch " + batchId + "   generated " + new Date().toISOString() + "\n\n";
  for (let i = 0; i < order.length; i++) {
    const g = groups[order[i]];
    txt += "=".repeat(96) + "\n";
    txt += "Seller: " + g.organizer + (g.taxNo ? "  (tax no. " + g.taxNo + ")" : "") + "\n";
    txt += "=".repeat(96) + "\n";
    txt += left("Invoice", 20) + left("Order", 10) + left("Customer", 24) + left("Qty", 5) + "         Net" + "         VAT" + "       Gross\n";
    for (let j = 0; j < g.lines.length; j++) {
      const l = g.lines[j];
      txt +=
        left(l.invoiceNo, 20) + left(l.orderNumber, 10) + left(l.customer, 24) + left(String(l.tickets), 5) +
        col(l.netCents / 100, 12) + col(l.vatCents / 100, 12) + col(l.grossCents / 100, 12) + "\n";
    }
    txt += "-".repeat(96) + "\n";
    txt += left("Total", 59) + col(g.netCents / 100, 12) + col(g.vatCents / 100, 12) + col(g.grossCents / 100, 12) + "\n";
    txt += "VAT 27% included in the gross amounts.\n\n";
  }

  const dir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const csvFile = path.join(dir, "invoices-" + start.toISOString().substring(0, 7) + ".csv");
  const txtFile = path.join(dir, "invoices-" + start.toISOString().substring(0, 7) + ".txt");
  fs.writeFileSync(csvFile, csv);
  fs.writeFileSync(txtFile, txt);
  console.log("[invoices] wrote " + csvFile + " and " + txtFile);

  // every organizer gets its own block of the printable copy
  let mails = 0;
  for (let i = 0; i < order.length; i++) {
    const g = groups[order[i]];
    let body = "Dear " + g.organizer + ",\n\nattached are the ticket invoices TicketBay issued in your name for " + month + ".\n\n";
    body += "  invoices:  " + g.lines.length + "\n";
    body += "  net:       " + col(g.netCents / 100, 12) + " EUR\n";
    body += "  VAT 27%:   " + col(g.vatCents / 100, 12) + " EUR\n";
    body += "  gross:     " + col(g.grossCents / 100, 12) + " EUR\n\n";
    body += "First invoice: " + g.lines[0].invoiceNo + ", last invoice: " + g.lines[g.lines.length - 1].invoiceNo + "\n";
    body += "\nThanks,\nTicketBay Finance\n";
    sendMail(g.email, "TicketBay invoices " + month + " (" + batchId + ")", body);
    mails++;
  }

  const result = {
    batchId: batchId,
    month: start.toISOString().substring(0, 7),
    generatedAt: new Date().toISOString(),
    organizers: order.map((name) => groups[name]),
    totals: { invoices: rows.length, netCents: totalNet, vatCents: totalVat, grossCents: totalGross },
    files: [path.relative(process.cwd(), csvFile), path.relative(process.cwd(), txtFile)],
    emailsSent: mails,
  };
  lastInvoiceExport = result;
  return result;
}
