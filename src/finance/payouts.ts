// Organizer payout report.
//
// Finance runs this before every payout batch: for one event (or every event of
// one organizer) and a date range it adds up what the customers paid, takes off
// the TicketBay service fees and the refunds, and the rest is what we owe the
// organizer. Writes the CSV that goes to the bank upload, emails the organizer
// a summary, and returns everything as JSON for the admin screen.
//
// NOTE: numbers must match the bank export from the old PHP system, do not
// "clean up" the rounding without talking to finance first.
import fs from "fs";
import path from "path";
import { getDb } from "../db/client";

const FEE_PERCENT = 0.03; // service fee, same as checkout
const FEE_MIN = 100; // cents
const FEE_MAX = 2000; // cents
const VAT = 0.27;
const DAY = 24 * 60 * 60 * 1000;
const PAYOUT_DELAY_DAYS = 7; // organizer gets paid a week after the show

// organizers by venue, until we have an organizers table (TB-212)
const ORGANIZERS: any = {
  "Budapest Park": { name: "Park Live Events Kft.", email: "finance@parklive.example", iban: "HU42 1177 3016 1111 1018 0000 0000" },
  "Zamárdi Beach": { name: "Lakeside Festivals Kft.", email: "accounts@lakeside-fest.example", iban: "HU93 1160 0006 0000 0000 1234 5676" },
  "Hungexpo Hall G": { name: "CraftConf Szervező Kft.", email: "billing@craftconf.example", iban: "HU86 1040 1308 5052 6748 5151 1005" },
  "Dumaszínház": { name: "Stand-up Színház Bt.", email: "penzugy@standup.example", iban: "HU74 1200 1008 0011 2233 0010 0003" },
  "MVM Dome": { name: "Dome Arena Productions Zrt.", email: "settlements@domearena.example", iban: "HU07 1091 8001 0000 0012 3456 0001" },
  "Kisüzem": { name: "Kisüzem Kulturális Egyesület", email: "hello@kisuzem.example", iban: "HU55 1173 6006 2000 0123 0000 0000" },
  "A38 Ship": { name: "Danube Stage Kft.", email: "finance@danubestage.example", iban: "HU17 1010 0109 0000 0123 4567 8900" },
  "Opus Jazz Club": { name: "Opus Music Kft.", email: "office@opusmusic.example", iban: "HU68 1176 3842 0010 0337 0000 0000" },
};

// cache of event rows, the events table hardly changes
let eventCache: any = {};
let eventCacheTime = 0;
let reportNo = 0;
export let lastPayoutReport: any = null;

class Mailer {
  host: string;
  port: number;
  sent: number = 0;
  constructor(opts: any) {
    this.host = opts.host;
    this.port = opts.port;
  }
  send(to: string, subject: string, body: string) {
    // TODO: real SMTP once ops gives us credentials, for now the outbox file is what finance reads
    this.sent++;
    console.log("[mailer] -> " + to + " (" + subject + ") via " + this.host + ":" + this.port);
    try {
      fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
      fs.appendFileSync(
        path.join(process.cwd(), "reports", "outbox.log"),
        "To: " + to + "\nSubject: " + subject + "\nDate: " + new Date().toUTCString() + "\n\n" + body + "\n-----\n",
      );
    } catch (e) {
      console.log("[mailer] could not write outbox", e);
    }
  }
}

const mailer = new Mailer({ host: process.env.SMTP_HOST || "localhost", port: 25 });

function money(eur: number) {
  const parts = eur.toFixed(2).split(".");
  let whole = parts[0];
  const dec = parts[1];
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return whole + "," + dec.padEnd(2, "0") + " EUR";
}

function ymd(d: Date) {
  return d.toISOString().substring(0, 10);
}

function getOrganizer(venue: string) {
  if (ORGANIZERS[venue]) return ORGANIZERS[venue];
  return { name: venue, email: "payouts@ticketbay.example", iban: "" };
}

function csvField(s: any) {
  s = "" + s;
  if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function payoutReport(params: any) {
  const db = getDb();
  const now = Date.now();
  const eventId = params.event;
  const organizer = params.organizer;

  let from = params.from ? new Date(params.from) : new Date(now - 30 * DAY);
  let to = params.to ? new Date(params.to) : new Date(now);
  console.log("[payouts] report for " + (eventId || organizer) + " from " + from.toISOString() + " to " + to.toISOString());

  // one bucket per day for the "best day" line in the email
  let days = Math.ceil((to.getTime() - from.getTime()) / DAY);
  const daily = new Array(Math.min(days, 366)).fill(0);

  if (now - eventCacheTime > 10 * 60 * 1000) {
    eventCache = {};
    eventCacheTime = now;
  }

  let eventIds: string[] = [];
  if (eventId) {
    if (!eventCache[eventId]) {
      const r = await db.$client.query("SELECT * FROM events WHERE id = $1", [eventId]);
      if (r.rows.length == 0) {
        console.log("[payouts] no such event " + eventId);
        return null;
      }
      eventCache[eventId] = r.rows[0];
    }
    eventIds.push(eventId);
  } else {
    const r = await db.$client.query("SELECT * FROM events WHERE venue = $1 ORDER BY starts_at_ms", [organizer]);
    for (let i = 0; i < r.rows.length; i++) {
      eventCache[r.rows[i].id] = r.rows[i];
      eventIds.push(r.rows[i].id);
    }
  }

  reportNo++;
  const reportId = "PAY-" + ymd(new Date()).replace(/-/g, "") + "-" + reportNo;
  const results: any[] = [];
  let totalGross = 0;
  let totalFees = 0;
  let totalRefunds = 0;
  let totalPayout = 0;

  for (let i = 0; i < eventIds.length; i++) {
    const ev = eventCache[eventIds[i]];
    const res = await db.$client.query(
      "SELECT * FROM orders WHERE event_id = $1 AND created_at_ms >= $2 AND created_at_ms <= $3 ORDER BY created_at_ms",
      [ev.id, from.getTime(), to.getTime()],
    );
    const rows = res.rows;
    console.log("[payouts] " + ev.id + ": " + rows.length + " orders");
    // console.log(JSON.stringify(rows, null, 2));

    const firstSale = new Date(Number(rows[0].created_at_ms));
    const lastSale = new Date(Number(rows[rows.length - 1].created_at_ms));

    // paid orders
    let gross = 0;
    let fees = 0;
    let tickets = 0;
    let paidCount = 0;
    for (let j = 0; j < rows.length; j++) {
      const o = rows[j];
      if (o.status != "paid") continue;
      const ticketsCents = parseInt(o.tickets_cents);
      let fee = Math.round(ticketsCents * FEE_PERCENT);
      if (fee < FEE_MIN) fee = FEE_MIN;
      if (fee > FEE_MAX) fee = FEE_MAX;
      gross += o.total_cents / 100;
      fees += fee;
      tickets += o.quantity;
      paidCount++;
      const d = Math.floor((Number(o.created_at_ms) - from.getTime()) / DAY);
      if (d < daily.length) daily[d] += ticketsCents;
    }

    // refunded orders
    let refundGross = 0;
    let refundFees = 0;
    let refunds = 0;
    let refundedTickets = 0;
    let refundedCount = 0;
    for (let j = 0; j < rows.length; j++) {
      const o = rows[j];
      if (o.status != "refunded") continue;
      const ticketsCents = parseInt(o.tickets_cents);
      let fee = Math.round(ticketsCents * FEE_PERCENT);
      if (fee < FEE_MIN) fee = FEE_MIN;
      if (fee > FEE_MAX) fee = FEE_MAX;
      refundGross += o.total_cents / 100;
      refundFees += fee;
      // the platform keeps its refund fee too, so take both off
      refunds += Number(o.refund_cents || 0) + Number(o.refund_fee_cents || 0);
      refundedTickets += o.quantity;
      refundedCount++;
      const d = Math.floor((Number(o.created_at_ms) - from.getTime()) / DAY);
      if (d < daily.length) daily[d] += ticketsCents;
    }

    const grossCents = Math.round((gross + refundGross) * 100);
    const feeCents = fees + refundFees;
    const payoutCents = grossCents - feeCents - refunds;
    const payoutEur = payoutCents / 100;
    const vatEur = (payoutEur * VAT) / (1 + VAT);
    const vatCents = Math.round(vatEur * 100);
    // what the organizer gets per ticket still standing
    const perTicket = payoutEur / tickets;

    // payout status
    let status = "";
    let payable = false;
    let dueDate: Date | null = null;
    if (ev.cancelled_at_ms != null) {
      status = "CANCELLED";
      payable = false;
    } else if (Number(ev.starts_at_ms) > now) {
      status = "UPCOMING";
      payable = false;
      dueDate = new Date(Number(ev.starts_at_ms) + PAYOUT_DELAY_DAYS * DAY);
    } else if (Number(ev.starts_at_ms) + PAYOUT_DELAY_DAYS * DAY > now) {
      status = "PENDING";
      payable = false;
      dueDate = new Date(Number(ev.starts_at_ms) + PAYOUT_DELAY_DAYS * DAY);
    } else if (payoutCents > 0) {
      status = "PAYABLE";
      payable = true;
      dueDate = new Date(Number(ev.starts_at_ms) + PAYOUT_DELAY_DAYS * DAY);
    } else {
      status = "NOTHING_TO_PAY";
      payable = false;
    }

    totalGross += grossCents;
    totalFees += feeCents;
    totalRefunds += refunds;
    totalPayout += payoutCents;

    results.push({
      eventId: ev.id,
      eventName: ev.name,
      venue: ev.venue,
      organizer: getOrganizer(ev.venue).name,
      status: status,
      payable: payable,
      dueDate: dueDate ? ymd(dueDate) : null,
      orders: paidCount + refundedCount,
      refundedOrders: refundedCount,
      ticketsSold: tickets,
      grossCents: grossCents,
      serviceFeesCents: feeCents,
      refundsCents: refunds,
      payoutCents: payoutCents,
      vatCents: vatCents,
      payout: money(payoutEur),
      payoutPerTicket: money(perTicket),
      firstSale: firstSale.toISOString(),
      lastSale: lastSale.toISOString(),
    });
  }

  // best day for the email
  let best = 0;
  for (let k = 1; k < daily.length; k++) {
    if (daily[k] > daily[best]) best = k;
  }
  const bestDay = new Date(from.getTime() + best * DAY);

  // CSV for the bank upload
  let csv = "report_id,event_id,event_name,organizer,iban,status,due_date,orders,tickets,gross_eur,fees_eur,refunds_eur,payout_eur,vat_eur\n";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const org = getOrganizer(r.venue);
    csv +=
      reportId + "," + csvField(r.eventId) + "," + csvField(r.eventName) + "," + csvField(org.name) + "," + csvField(org.iban) + "," +
      r.status + "," + (r.dueDate || "") + "," + r.orders + "," + r.ticketsSold + "," +
      (r.grossCents / 100).toFixed(2) + "," + (r.serviceFeesCents / 100).toFixed(2) + "," + (r.refundsCents / 100).toFixed(2) + "," +
      (r.payoutCents / 100).toFixed(2) + "," + (r.vatCents / 100).toFixed(2) + "\n";
  }
  csv +=
    reportId + ",TOTAL,,,,,,,," +
    (totalGross / 100).toFixed(2) + "," + (totalFees / 100).toFixed(2) + "," + (totalRefunds / 100).toFixed(2) + "," +
    (totalPayout / 100).toFixed(2) + ",\n";

  const dir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, "payouts-" + ymd(new Date()) + ".csv");
  fs.writeFileSync(file, csv);
  console.log("[payouts] wrote " + file);

  // email the organizer(s)
  const sentTo: any = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const org = getOrganizer(r.venue);
    if (sentTo[org.email]) continue;
    sentTo[org.email] = true;
    let body = "Dear " + org.name + ",\n\nyour TicketBay payout summary for " + ymd(from) + " - " + ymd(to) + ":\n\n";
    for (let j = 0; j < results.length; j++) {
      const x = results[j];
      if (getOrganizer(x.venue).email != org.email) continue;
      body += "  " + x.eventName + "\n";
      body += "    tickets sold: " + x.ticketsSold + "\n";
      body += "    payout:       " + x.payout + " (incl. VAT " + money(x.vatCents / 100) + ")\n";
      body += "    per ticket:   " + x.payoutPerTicket + "\n";
      if (x.status == "PAYABLE") body += "    status:       paid out on " + x.dueDate + "\n";
      else if (x.status == "PENDING") body += "    status:       will be paid on " + x.dueDate + "\n";
      else if (x.status == "UPCOMING") body += "    status:       held until the event (paid on " + x.dueDate + ")\n";
      else if (x.status == "CANCELLED") body += "    status:       event cancelled, all tickets refunded\n";
      else body += "    status:       nothing to pay\n";
    }
    body += "\nBest sales day: " + ymd(bestDay) + "\n\nThanks,\nTicketBay Finance\n";
    mailer.send(org.email, "TicketBay payout report " + reportId, body);
  }

  const report = {
    reportId: reportId,
    generatedAt: new Date().toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    events: results,
    totals: {
      grossCents: totalGross,
      serviceFeesCents: totalFees,
      refundsCents: totalRefunds,
      payoutCents: totalPayout,
      payout: money(totalPayout / 100),
    },
    csvFile: path.relative(process.cwd(), file),
    emailsSent: Object.keys(sentTo).length,
  };
  lastPayoutReport = report;
  return report;
}
