// Organizer invoice export.
//
// The organizers are the sellers of the tickets, so the invoices for the ticket
// part of every order are theirs; we prepare them monthly and the organizers'
// accountants import the CSV (the .txt is the printable copy). The money and
// the documents are built in src/domain/invoice-export.ts; this file reads the
// paid orders, writes the files and sends the mails.
//
// Copied from the payout report and adjusted, keep the two in sync.
import fs from "fs";
import path from "path";
import { getDb } from "../db/client";
import { buildInvoiceExport, invoiceMonth, type InvoiceOrderRow } from "../domain/invoice-export";

// running invoice number, continues where the last export stopped
let invoiceSeq = 1;
export let lastInvoiceExport: any = null;

// same fake transport as the payout report, the accountants read the outbox file
function sendMail(to: string, subject: string, body: string) {
  console.log("[invoices] mail -> " + to + " (" + subject + ")");
  try {
    // Stryker disable next-line StringLiteral: equivalent — reports/ is always created before sendMail runs
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.appendFileSync(
      path.join(process.cwd(), "reports", "outbox.log"),
      "To: " + to + "\nSubject: " + subject + "\nDate: " + new Date().toUTCString() + "\n\n" + body + "\n-----\n",
    );
  } catch (e) {
    console.log("[invoices] could not write outbox", e);
  }
}

export async function invoiceExport(params: any) {
  const db = getDb();

  let month = params.month;
  if (!month) {
    const d = new Date();
    month = d.getFullYear() + "-" + (d.getMonth() + 1);
  }
  const { start, end } = invoiceMonth(month);
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
  const rows: InvoiceOrderRow[] = res.rows;
  console.log("[invoices] " + rows.length + " paid orders");

  const built = buildInvoiceExport({ rows, month, now: new Date(), nextInvoiceSeq: () => invoiceSeq++ });

  const dir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const csvFile = path.join(dir, "invoices-" + start.toISOString().substring(0, 7) + ".csv");
  const txtFile = path.join(dir, "invoices-" + start.toISOString().substring(0, 7) + ".txt");
  fs.writeFileSync(csvFile, built.csv);
  fs.writeFileSync(txtFile, built.txt);
  console.log("[invoices] wrote " + csvFile + " and " + txtFile);

  for (const mail of built.mails) sendMail(mail.to, mail.subject, mail.body);

  const result = {
    ...built.result,
    files: [path.relative(process.cwd(), csvFile), path.relative(process.cwd(), txtFile)],
    emailsSent: built.mails.length,
  };
  lastInvoiceExport = result;
  return result;
}
