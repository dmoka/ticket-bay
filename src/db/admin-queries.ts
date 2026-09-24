// Read models for the admin dashboard. The data set is small (hundreds of
// orders), so aggregates are computed in plain TypeScript over one read —
// easy to test, and every sum stays in integer cents.
import { and, asc, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "./client";
import { discountCodes, events, orders, type DiscountCodeRow, type EventRow, type OrderRow } from "./schema";

const DAY = 86_400_000;

export interface Kpi {
  cur: number;
  prev: number;
  /** one value per day of the current period */
  series: number[];
}

export interface DayPoint {
  dayStartMs: number;
  revenueCents: number;
  prevRevenueCents: number;
  tickets: number;
  refundsCents: number;
}

export interface EventPerformance {
  event: EventRow;
  revenueCents: number;
  tickets: number;
  orders: number;
}

export interface Overview {
  days: number;
  periodStartMs: number;
  revenue: Kpi;
  tickets: Kpi;
  refunds: Kpi & { count: number };
  /** basis points (0-10000) so the ratio stays an integer */
  sellThrough: Kpi;
  daily: DayPoint[];
  topEvents: EventPerformance[];
  recent: { order: OrderRow; event: EventRow }[];
}

function sumIn(rows: OrderRow[], from: number, to: number, at: (o: OrderRow) => number | null, value: (o: OrderRow) => number) {
  let s = 0;
  for (const o of rows) {
    const t = at(o);
    if (t !== null && t >= from && t < to) s += value(o);
  }
  return s;
}

/** Seats held at instant T over total capacity, in basis points. */
function sellThroughAt(rows: OrderRow[], capacity: number, t: number): number {
  let held = 0;
  for (const o of rows) {
    if (o.createdAtMs <= t) held += o.quantity;
    if (o.refundedAtMs !== null && o.refundedAtMs <= t && o.seatsReleased) held -= o.quantity;
  }
  return capacity > 0 ? Math.round((held * 10_000) / capacity) : 0;
}

export function getOverview(db: DbLike, nowMs: number, days: number): Overview {
  const allOrders = db.select().from(orders).all();
  const allEvents = db.select().from(events).orderBy(asc(events.startsAtMs)).all();
  const capacity = allEvents.reduce((s, e) => s + e.totalSeats, 0);
  const start = nowMs - days * DAY;
  const prevStart = start - days * DAY;

  const created = (o: OrderRow) => o.createdAtMs;
  const refunded = (o: OrderRow) => o.refundedAtMs;
  const revenue = (o: OrderRow) => o.totalCents;
  const qty = (o: OrderRow) => o.quantity;
  const refund = (o: OrderRow) => o.refundCents ?? 0;

  const daily: DayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const a = start + i * DAY;
    const b = a + DAY;
    daily.push({
      dayStartMs: a,
      revenueCents: sumIn(allOrders, a, b, created, revenue),
      prevRevenueCents: sumIn(allOrders, a - days * DAY, b - days * DAY, created, revenue),
      tickets: sumIn(allOrders, a, b, created, qty),
      refundsCents: sumIn(allOrders, a, b, refunded, refund),
    });
  }

  const byEvent = new Map<string, EventPerformance>();
  for (const e of allEvents) byEvent.set(e.id, { event: e, revenueCents: 0, tickets: 0, orders: 0 });
  for (const o of allOrders) {
    if (o.createdAtMs < start || o.createdAtMs >= nowMs) continue;
    const p = byEvent.get(o.eventId)!;
    p.revenueCents += o.totalCents;
    p.tickets += o.quantity;
    p.orders += 1;
  }

  const eventById = new Map(allEvents.map((e) => [e.id, e]));
  const recent = [...allOrders]
    .filter((o) => o.createdAtMs < nowMs)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 7)
    .map((order) => ({ order, event: eventById.get(order.eventId)! }));

  return {
    days,
    periodStartMs: start,
    revenue: {
      cur: sumIn(allOrders, start, nowMs, created, revenue),
      prev: sumIn(allOrders, prevStart, start, created, revenue),
      series: daily.map((d) => d.revenueCents),
    },
    tickets: {
      cur: sumIn(allOrders, start, nowMs, created, qty),
      prev: sumIn(allOrders, prevStart, start, created, qty),
      series: daily.map((d) => d.tickets),
    },
    refunds: {
      cur: sumIn(allOrders, start, nowMs, refunded, refund),
      prev: sumIn(allOrders, prevStart, start, refunded, refund),
      count: sumIn(allOrders, start, nowMs, refunded, () => 1),
      series: daily.map((d) => d.refundsCents),
    },
    sellThrough: {
      cur: sellThroughAt(allOrders, capacity, nowMs),
      prev: sellThroughAt(allOrders, capacity, start),
      series: daily.map((d) => sellThroughAt(allOrders, capacity, d.dayStartMs + DAY)),
    },
    daily,
    topEvents: [...byEvent.values()].filter((p) => p.orders > 0).sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 6),
    recent,
  };
}

export interface EventAdminRow {
  event: EventRow;
  revenueCents: number;
  refundedCents: number;
  orders: number;
  refunds: number;
}

export function listEventsAdmin(db: DbLike): EventAdminRow[] {
  const stats = db
    .select({
      eventId: orders.eventId,
      revenueCents: sql<number>`coalesce(sum(${orders.totalCents}), 0)`,
      refundedCents: sql<number>`coalesce(sum(${orders.refundCents}), 0)`,
      orders: sql<number>`count(*)`,
      refunds: sql<number>`sum(case when ${orders.status} = 'refunded' then 1 else 0 end)`,
    })
    .from(orders)
    .groupBy(orders.eventId)
    .all();
  const byId = new Map(stats.map((s) => [s.eventId, s]));
  return db
    .select()
    .from(events)
    .orderBy(asc(events.startsAtMs))
    .all()
    .map((event) => {
      const s = byId.get(event.id);
      return {
        event,
        revenueCents: s?.revenueCents ?? 0,
        refundedCents: s?.refundedCents ?? 0,
        orders: s?.orders ?? 0,
        refunds: s?.refunds ?? 0,
      };
    });
}

export type OrderSort = "created" | "total" | "quantity" | "event";
export interface OrderFilter {
  status?: "paid" | "refunded";
  eventId?: string;
  q?: string;
  sort?: OrderSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export function listOrdersAdmin(db: DbLike, f: OrderFilter): { rows: { order: OrderRow; event: EventRow }[]; total: number } {
  const where: SQL[] = [];
  if (f.status) where.push(eq(orders.status, f.status));
  if (f.eventId) where.push(eq(orders.eventId, f.eventId));
  const q = f.q?.trim();
  if (q) {
    const idMatch = /^(?:TB-)?0*(\d+)$/i.exec(q);
    const text = or(like(orders.customerEmail, `%${q.toLowerCase()}%`), like(orders.customerName, `%${q}%`))!;
    where.push(idMatch ? or(text, eq(orders.id, Number(idMatch[1])))! : text);
  }
  const cond = where.length ? and(...where) : undefined;
  const col = { created: orders.createdAtMs, total: orders.totalCents, quantity: orders.quantity, event: events.name }[f.sort ?? "created"];
  const order = f.dir === "asc" ? asc(col) : desc(col);
  const rows = db
    .select()
    .from(orders)
    .innerJoin(events, eq(orders.eventId, events.id))
    .where(cond)
    .orderBy(order, desc(orders.id))
    .limit(f.limit ?? 50)
    .offset(f.offset ?? 0)
    .all()
    .map((r) => ({ order: r.orders, event: r.events }));
  const total = db.select({ n: sql<number>`count(*)` }).from(orders).where(cond).get()?.n ?? 0;
  return { rows, total };
}

export function listRefunds(db: DbLike): { order: OrderRow; event: EventRow }[] {
  return db
    .select()
    .from(orders)
    .innerJoin(events, eq(orders.eventId, events.id))
    .where(eq(orders.status, "refunded"))
    .orderBy(desc(orders.refundedAtMs))
    .all()
    .map((r) => ({ order: r.orders, event: r.events }));
}

export interface CodeAdminRow {
  code: DiscountCodeRow;
  orders: number;
  revenueCents: number;
  discountCents: number;
}

export function listCodesAdmin(db: DbLike): CodeAdminRow[] {
  const stats = db
    .select({
      code: orders.discountCode,
      orders: sql<number>`count(*)`,
      revenueCents: sql<number>`coalesce(sum(${orders.totalCents}), 0)`,
      // the code's own share of each order's discount, rounded per order
      discountCents: sql<number>`coalesce(sum((${orders.subtotalCents} * ${orders.codePercent} + 50) / 100), 0)`,
    })
    .from(orders)
    .where(sql`${orders.discountCode} is not null`)
    .groupBy(orders.discountCode)
    .all();
  const byCode = new Map(stats.map((s) => [s.code, s]));
  return db
    .select()
    .from(discountCodes)
    .orderBy(asc(discountCodes.code))
    .all()
    .map((code) => {
      const s = byCode.get(code.code);
      return { code, orders: s?.orders ?? 0, revenueCents: s?.revenueCents ?? 0, discountCents: s?.discountCents ?? 0 };
    });
}
