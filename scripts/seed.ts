// Realistic demo data: 8 events, ~300 orders over the last 60 days, refunds,
// discount codes. Deterministic (seeded PRNG) relative to the current hour, so
// every run tells the same story. Every amount goes through the real domain
// modules — the seed cannot produce an order the app itself would not.
import { previewCancellation } from "../src/domain/cancellation";
import { buildInvoice } from "../src/domain/invoice";
import type { Event } from "../src/domain/booking";
import { sql } from "drizzle-orm";
import { closeDb, databaseUrl, migrateDb, openDb } from "../src/db/client";
import { discountCodes, events, orders } from "../src/db/schema";
import { loadLocalEnv } from "./local-env";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260924);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

type Category = "concert" | "festival" | "conference" | "comedy";
interface SeedEvent {
  id: string;
  name: string;
  category: Category;
  venue: string;
  city: string;
  description: string;
  inDays: number;
  hour: number;
  seats: number;
  priceCents: number;
  /** share of seats sold; 1 = sold out */
  sell: number;
}

const EVENTS: SeedEvent[] = [
  {
    id: "midnight-arcade-neon-tour",
    name: "Midnight Arcade — Neon Tour",
    category: "concert",
    venue: "Budapest Park",
    city: "Budapest",
    description: "Synthwave duo Midnight Arcade bring the Neon Tour to the open-air stage. Doors 19:00, support act 19:45.",
    inDays: 12,
    hour: 20,
    seats: 300,
    priceCents: 5900,
    sell: 0.62,
  },
  {
    id: "balaton-sound-weekend",
    name: "Balaton Sound Weekend",
    category: "festival",
    venue: "Zamárdi Beach",
    city: "Zamárdi",
    description: "Three stages on the lakeshore, forty artists, one long weekend. Weekend pass, camping not included.",
    inDays: 62,
    hour: 14,
    seats: 800,
    priceCents: 14900,
    sell: 0.16,
  },
  {
    id: "craftconf-agents-in-production",
    name: "CraftConf: Agents in Production",
    category: "conference",
    venue: "Hungexpo Hall G",
    city: "Budapest",
    description: "A one-day conference on shipping AI coding agents without shipping their bugs. Talks, workshops, hallway track.",
    inDays: 45,
    hour: 9,
    seats: 200,
    priceCents: 34900,
    sell: 0.34,
  },
  {
    id: "deadline-driven-standup",
    name: "Deadline Driven — Stand-up Night",
    category: "comedy",
    venue: "Dumaszínház",
    city: "Budapest",
    description: "Five comedians, one theme: the sprint that never ends. English-language show.",
    inDays: 5,
    hour: 20,
    seats: 60,
    priceCents: 2400,
    sell: 1,
  },
  {
    id: "nova-kings-arena",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "MVM Dome",
    city: "Budapest",
    description: "The only Central European date of the Nova Kings world tour. Standing floor, no re-entry.",
    inDays: 18,
    hour: 20,
    seats: 120,
    priceCents: 7900,
    sell: 1,
  },
  {
    id: "comedy-cellar-open-mic",
    name: "Comedy Cellar Open Mic",
    category: "comedy",
    venue: "Kisüzem",
    city: "Budapest",
    description: "New material night. Ten-minute sets, a friendly room, and a host who keeps it moving.",
    inDays: 34,
    hour: 21,
    seats: 50,
    priceCents: 1500,
    sell: 0.3,
  },
  {
    id: "velvet-static-live",
    name: "The Velvet Static — Live",
    category: "concert",
    venue: "A38 Ship",
    city: "Budapest",
    description: "Shoegaze on the Danube. The album-release show for 'Low Frequency Weather'.",
    inDays: -20,
    hour: 20,
    seats: 180,
    priceCents: 4500,
    sell: 0.82,
  },
  {
    id: "budapest-jazz-evening",
    name: "Budapest Jazz Evening",
    category: "concert",
    venue: "Opus Jazz Club",
    city: "Budapest",
    description: "A quartet evening of standards and originals, two sets with an interval.",
    inDays: -41,
    hour: 19,
    seats: 80,
    priceCents: 3900,
    sell: 0.86,
  },
];

const CODES = [
  { code: "WELCOME10", percent: 10, active: true, maxUses: null, expiresAtMs: null },
  { code: "STUDENT15", percent: 15, active: true, maxUses: null, expiresAtMs: null },
  { code: "CRAFT20", percent: 20, active: true, maxUses: 40, expiresAtMs: NOW + 40 * DAY },
  { code: "SUMMER25", percent: 25, active: true, maxUses: 100, expiresAtMs: NOW - 15 * DAY },
  { code: "LAUNCH50", percent: 50, active: false, maxUses: 10, expiresAtMs: null },
] as const;

const FIRST = ["Anna", "Bence", "Chloe", "Dávid", "Emma", "Felix", "Greta", "Hugo", "Ida", "Jonas", "Kata", "Levente", "Mira", "Noah", "Olivia", "Péter", "Rita", "Sam", "Tamara", "Viktor", "Zoe", "Lukas", "Nóra", "Marco", "Eszter", "Tom", "Lena", "Ádám", "Julia", "Oscar"];
const LAST = ["Nagy", "Kovács", "Smith", "Tóth", "Müller", "Horváth", "Rossi", "Szabó", "Novak", "Varga", "Weber", "Kiss", "Fischer", "Molnár", "Brown", "Farkas", "Lang", "Balogh", "Keller", "Papp"];
const DOMAINS = ["gmail.com", "proton.me", "outlook.com", "icloud.com", "fastmail.com"];

const CUSTOMERS = Array.from({ length: 140 }, () => {
  const first = pick(FIRST);
  const last = pick(LAST);
  const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return { name: `${first} ${last}`, email: `${ascii(first)}.${ascii(last)}@${pick(DOMAINS)}` };
});
export const DEMO_CUSTOMER = { name: "Alex Morgan", email: "alex.morgan@example.com" };

function quantity(): number {
  const r = rand();
  if (r < 0.26) return 1;
  if (r < 0.66) return 2;
  if (r < 0.78) return 3;
  if (r < 0.9) return 4;
  if (r < 0.96) return 5 + Math.floor(rand() * 3);
  return 10;
}

interface Draft {
  ev: SeedEvent;
  startMs: number;
  qty: number;
  createdAtMs: number;
  customer: { name: string; email: string };
}

loadLocalEnv();
const db = openDb(databaseUrl());
await migrateDb(db);

const startOf = (e: SeedEvent) => {
  const d = new Date(NOW + e.inDays * DAY);
  d.setHours(e.hour, 0, 0, 0);
  return d.getTime();
};

// 1. Order drafts per event, until each event reaches its sell-through.
const drafts: Draft[] = [];
for (const ev of EVENTS) {
  const startMs = startOf(ev);
  const saleOpens = NOW - 60 * DAY;
  const saleCloses = Math.min(NOW - HOUR, startMs - 2 * HOUR);
  const target = Math.round(ev.seats * ev.sell);
  let sold = 0;
  while (sold < target) {
    const qty = Math.min(quantity(), target - sold);
    // A mild skew toward the end of the window: momentum, not a flat line.
    const createdAtMs = Math.round(saleOpens + (saleCloses - saleOpens) * rand() ** 0.8);
    drafts.push({ ev, startMs, qty, createdAtMs, customer: pick(CUSTOMERS) });
    sold += qty;
  }
}

// The demo customer: a history worth showing on "My orders".
const demo = (id: string, qty: number, daysAgo: number) => {
  const ev = EVENTS.find((e) => e.id === id)!;
  drafts.push({ ev, startMs: startOf(ev), qty, createdAtMs: NOW - daysAgo * DAY - Math.round(rand() * 10 * HOUR), customer: DEMO_CUSTOMER });
};
demo("midnight-arcade-neon-tour", 2, 9);
demo("craftconf-agents-in-production", 1, 21);
demo("velvet-static-live", 2, 35);
demo("comedy-cellar-open-mic", 4, 3);

drafts.sort((a, b) => a.createdAtMs - b.createdAtMs);

// 2. Price each draft with the real invoice module, as of the moment it was placed.
const codeUses = new Map<string, number>();
const seatsSold = new Map<string, number>();
const rows: (typeof orders.$inferInsert)[] = [];
let n = 0;
for (const d of drafts) {
  n++;
  const domainEvent: Event = { id: d.ev.id, name: d.ev.name, totalSeats: d.ev.seats, seatsSold: 0, priceCents: d.ev.priceCents, startMs: d.startMs };
  let code: (typeof CODES)[number] | undefined;
  if (rand() < 0.13) {
    const usable = CODES.filter(
      (c) =>
        c.active &&
        (c.expiresAtMs === null || d.createdAtMs < c.expiresAtMs) &&
        (c.maxUses === null || (codeUses.get(c.code) ?? 0) < c.maxUses),
    );
    if (usable.length) code = pick(usable);
  }
  const inv = buildInvoice(domainEvent, d.qty, d.createdAtMs, code?.percent ?? 0);
  if (code) codeUses.set(code.code, (codeUses.get(code.code) ?? 0) + 1);

  const row: typeof orders.$inferInsert = {
    eventId: d.ev.id,
    customerEmail: d.customer.email,
    customerName: d.customer.name,
    quantity: d.qty,
    subtotalCents: inv.subtotalCents,
    discountPercent: inv.discountPercent,
    groupPercent: inv.groupPercent,
    earlyBirdPercent: inv.earlyBirdPercent,
    codePercent: inv.codePercent,
    discountCode: code?.code ?? null,
    discountCents: inv.discountCents,
    ticketsCents: inv.ticketsCents,
    feeCents: inv.feeCents,
    totalCents: inv.totalCents,
    vatCents: inv.vatCents,
    status: "paid",
    paymentId: `ch_seed_${hex(24)}`,
    idempotencyKey: `seed-${n}`,
    createdAtMs: d.createdAtMs,
  };

  // 3. Some customers cancel. Sold-out shows stay sold out; the demo customer
  // cancels exactly one order (the past one, after the fact — refund 0).
  const isDemo = d.customer === DEMO_CUSTOMER;
  const late = d.ev.inDays < 0 && (isDemo || rand() < 0.03);
  const early = !isDemo && d.ev.sell < 1 && rand() < 0.08;
  if (late || early) {
    const lastMoment = Math.min(NOW - HOUR, d.startMs + (late ? 2 * DAY : -HOUR));
    const firstMoment = late ? d.startMs + HOUR : d.createdAtMs + HOUR;
    const refundedAtMs = Math.round(firstMoment + (lastMoment - firstMoment) * rand());
    if (refundedAtMs > d.createdAtMs && refundedAtMs < NOW) {
      const p = previewCancellation(
        { totalCents: inv.ticketsCents, tickets: d.qty, discountPercent: inv.discountPercent, eventStartMs: d.startMs },
        refundedAtMs,
      );
      Object.assign(row, {
        status: "refunded",
        refundedAtMs,
        refundCents: p.netCents,
        refundFeeCents: p.feeCents,
        seatsReleased: p.releasesSeats,
        refundId: p.netCents > 0 ? `re_seed_${hex(24)}` : null,
      });
    }
  }
  const holdsSeats = row.status === "paid" || row.seatsReleased === false;
  if (holdsSeats) seatsSold.set(d.ev.id, (seatsSold.get(d.ev.id) ?? 0) + d.qty);
  rows.push(row);
}

await db.transaction(async (tx) => {
  // RESTART IDENTITY: order numbers start again at TB-00001 on every reseed.
  await tx.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
  await tx.insert(events).values(
    EVENTS.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      venue: e.venue,
      city: e.city,
      description: e.description,
      startsAtMs: startOf(e),
      totalSeats: e.seats,
      seatsSold: Math.min(e.seats, seatsSold.get(e.id) ?? 0),
      priceCents: e.priceCents,
      createdAtMs: NOW - 75 * DAY,
    })),
  );
  await tx.insert(discountCodes).values(CODES.map((c) => ({ ...c, uses: codeUses.get(c.code) ?? 0, createdAtMs: NOW - 70 * DAY })));
  // In creation order, so order numbers follow the timeline.
  await tx.insert(orders).values(rows);
});
await closeDb(db);

const refunded = rows.filter((r) => r.status === "refunded").length;
console.log(`seeded ${new URL(databaseUrl()).pathname.slice(1)}: ${EVENTS.length} events, ${rows.length} orders (${refunded} refunded), ${CODES.length} discount codes`);
console.log(`demo customer: ${DEMO_CUSTOMER.email}`);
