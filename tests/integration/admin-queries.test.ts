// The admin read models over a small, hand-built history (real SQLite).
import { describe, it, expect } from "vitest";
import { getOverview, listCodesAdmin, listEventsAdmin, listOrdersAdmin, listRefunds } from "../../src/db/admin-queries";
import { addCode, DAY, NOW, shop, venue } from "./fixtures";

async function history() {
  const s = shop();
  const ev = venue(s.db, { totalSeats: 100, seatsSold: 0, startsAtMs: NOW + 20 * DAY });
  addCode(s.db, "WELCOME10", 10);
  // previous 7-day period: one order of 2
  s.setClock(NOW - 10 * DAY);
  await s.book(ev.id, 2, { email: "old@example.com" });
  // current 7-day period: 2 + 5 (with code), one of them cancelled
  s.setClock(NOW - 3 * DAY);
  const a = (await s.book(ev.id, 2, { email: "a@example.com" })).order;
  s.setClock(NOW - 2 * DAY);
  const b = (await s.book(ev.id, 5, { email: "b@example.com", code: "WELCOME10" })).order;
  s.setClock(NOW - DAY);
  await s.cancel(a.id);
  return { s, ev, a, b };
}

describe("admin overview", () => {
  it("sums revenue, tickets and refunds for the period and the one before", async () => {
    const { s, a, b } = await history();
    const o = getOverview(s.db, NOW, 7);
    expect(o.revenue.cur).toBe(a.totalCents + b.totalCents);
    expect(o.revenue.prev).toBe(9_270); // booked 30 days out: early-bird 10% + 3% fee
    expect(o.tickets.cur).toBe(7);
    expect(o.tickets.prev).toBe(2);
    expect(o.refunds.cur).toBe(9_800);
    expect(o.refunds.count).toBe(1);
    expect(o.revenue.series).toHaveLength(7);
    expect(o.revenue.series.reduce((x, y) => x + y, 0)).toBe(o.revenue.cur);
  });

  it("measures sell-through from seats actually held, in basis points", async () => {
    const { s } = await history();
    const o = getOverview(s.db, NOW, 7);
    // held now: 2 (old) + 5 (b) = 7 of 100; at the period start only the old 2
    expect(o.sellThrough.cur).toBe(700);
    expect(o.sellThrough.prev).toBe(200);
  });
});

describe("admin tables", () => {
  it("filters and sorts orders, and finds one by its TB- number", async () => {
    const { s, a, b } = await history();
    expect(listOrdersAdmin(s.db, {}).total).toBe(3);
    expect(listOrdersAdmin(s.db, { status: "refunded" }).rows.map((r) => r.order.id)).toEqual([a.id]);
    expect(listOrdersAdmin(s.db, { q: "b@example" }).rows.map((r) => r.order.id)).toEqual([b.id]);
    expect(listOrdersAdmin(s.db, { q: `TB-${String(b.id).padStart(5, "0")}` }).rows.map((r) => r.order.id)).toEqual([b.id]);
    const byTotal = listOrdersAdmin(s.db, { sort: "total", dir: "desc" }).rows.map((r) => r.order.totalCents);
    expect(byTotal).toEqual([...byTotal].sort((x, y) => y - x));
  });

  it("lists refunds, per-event revenue and per-code usage", async () => {
    const { s, ev, b } = await history();
    expect(listRefunds(s.db).map((r) => r.order.refundCents)).toEqual([9_800]);
    const [row] = listEventsAdmin(s.db).filter((r) => r.event.id === ev.id);
    expect(row).toMatchObject({ orders: 3, refunds: 1, refundedCents: 9_800 });
    const [code] = listCodesAdmin(s.db);
    expect(code).toMatchObject({ orders: 1, revenueCents: b.totalCents, discountCents: 2_500 });
  });
});
