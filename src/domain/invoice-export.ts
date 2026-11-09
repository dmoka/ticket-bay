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

function organizerFor(venue: string) {
  const o = ORGANIZERS[venue];
  if (o) return o;
  return { name: venue, email: "invoices@ticketbay.example", taxNo: "" };
}

/** The UTC month `month` ("YYYY-MM") names: [start, end). */
export function invoiceMonth(month: string): { start: Date; end: Date } {
  const parts = month.split("-");
  const y = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
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

export interface InvoiceExportInput {
  rows: InvoiceOrderRow[];
  /** the month as asked for, printed as is in the headings */
  month: string;
  /** when the export runs */
  now: Date;
  /** the running invoice number: called once per line, in line order */
  nextInvoiceSeq: () => number;
}

/** The export: the JSON result (without `files`), the CSV, the printable copy and the mails. */
export function buildInvoiceExport({ rows, month, now, nextInvoiceSeq }: InvoiceExportInput) {
  const { start } = invoiceMonth(month);

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

    const grossEur = parseFloat(String(o.tickets_cents)) / 100;
    const netEur = grossEur / (1 + VAT_RATE);
    const vatCents = Math.round((grossEur - netEur) * 100);
    const grossCents = Number(o.tickets_cents);
    const netCents = grossCents - vatCents;
    const discountPct = Math.round((Number(o.discount_cents) / Number(o.subtotal_cents)) * 100);

    const invoiceNo = "TB-" + start.toISOString().substring(0, 7).replace("-", "") + "-" + String(nextInvoiceSeq()).padStart(6, "0");
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
  let txt = "TICKETBAY - ORGANIZER INVOICES " + month + "\nBatch " + batchId + "   generated " + now.toISOString() + "\n\n";
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

  // every organizer gets a summary mail
  const mails: { to: string; subject: string; body: string }[] = [];
  for (let i = 0; i < order.length; i++) {
    const g = groups[order[i]];
    let body = "Dear " + g.organizer + ",\n\nattached are the ticket invoices TicketBay issued in your name for " + month + ".\n\n";
    body += "  invoices:  " + g.lines.length + "\n";
    body += "  net:       " + col(g.netCents / 100, 12) + " EUR\n";
    body += "  VAT 27%:   " + col(g.vatCents / 100, 12) + " EUR\n";
    body += "  gross:     " + col(g.grossCents / 100, 12) + " EUR\n\n";
    body += "First invoice: " + g.lines[0].invoiceNo + ", last invoice: " + g.lines[g.lines.length - 1].invoiceNo + "\n";
    body += "\nThanks,\nTicketBay Finance\n";
    mails.push({ to: g.email, subject: "TicketBay invoices " + month + " (" + batchId + ")", body });
  }

  return {
    result: {
      batchId: batchId,
      month: start.toISOString().substring(0, 7),
      generatedAt: now.toISOString(),
      organizers: order.map((name) => groups[name]),
      totals: { invoices: rows.length, netCents: totalNet, vatCents: totalVat, grossCents: totalGross },
    },
    csv,
    txt,
    mails,
  };
}
