// The demo seed must tell a consistent story: every stored amount is what the
// domain modules compute, and every event's seat count matches its orders.
// `npm run db:seed` runs for real, as a child process, against this file's
// own Postgres database.
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { discountCodes, events, orders, type DiscountCodeRow, type EventRow, type OrderRow } from "../../src/db/schema";
import { buildInvoice } from "../../src/domain/invoice";
import { previewCancellation } from "../../src/domain/cancellation";
import { useTestDatabase } from "./database";

const t = useTestDatabase({ truncate: false });
let allEvents: EventRow[];
let allOrders: OrderRow[];
let allCodes: DiscountCodeRow[];

beforeAll(async () => {
  execFileSync("npx", ["tsx", "scripts/seed.ts"], { env: { ...process.env, DATABASE_URL: t.url }, stdio: "pipe" });
  allEvents = await t.db.select().from(events);
  allOrders = await t.db.select().from(orders);
  allCodes = await t.db.select().from(discountCodes);
}, 60_000);

describe("db:seed", () => {
  it("creates 8 events, ~300 orders over 60 days, refunds and discount codes", () => {
    expect(allEvents).toHaveLength(8);
    expect(allOrders.length).toBeGreaterThanOrEqual(250);
    expect(allOrders.length).toBeLessThanOrEqual(400);
    expect(allOrders.filter((o) => o.status === "refunded").length).toBeGreaterThan(5);
    expect(allCodes.length).toBeGreaterThanOrEqual(3);
    const span = Math.max(...allOrders.map((o) => o.createdAtMs)) - Math.min(...allOrders.map((o) => o.createdAtMs));
    expect(span).toBeGreaterThan(50 * 86_400_000);
  });

  it("numbers orders from TB-00001 in the order they were placed", () => {
    const byId = [...allOrders].sort((a, b) => a.id - b.id);
    expect(byId[0].id).toBe(1);
    expect(byId.map((o) => o.createdAtMs)).toEqual([...byId.map((o) => o.createdAtMs)].sort((a, b) => a - b));
  });

  it("stores exactly what the invoice and refund modules compute", () => {
    const evs = new Map(allEvents.map((e) => [e.id, e]));
    for (const o of allOrders) {
      const e = evs.get(o.eventId)!;
      const inv = buildInvoice(
        { id: e.id, name: e.name, totalSeats: e.totalSeats, seatsSold: 0, priceCents: e.priceCents, startMs: e.startsAtMs },
        o.quantity,
        o.createdAtMs,
        o.codePercent,
      );
      expect(o).toMatchObject({ ticketsCents: inv.ticketsCents, feeCents: inv.feeCents, totalCents: inv.totalCents, vatCents: inv.vatCents });
      if (o.status === "refunded") {
        const p = previewCancellation(
          { totalCents: o.ticketsCents, tickets: o.quantity, discountPercent: o.discountPercent, eventStartMs: e.startsAtMs },
          o.refundedAtMs!,
        );
        expect(o).toMatchObject({ refundCents: p.netCents, refundFeeCents: p.feeCents, seatsReleased: p.releasesSeats });
      }
    }
  });

  it("keeps every event's seat count equal to the seats its orders hold", () => {
    const held = new Map<string, number>();
    for (const o of allOrders) {
      if (o.status === "paid" || o.seatsReleased === false) held.set(o.eventId, (held.get(o.eventId) ?? 0) + o.quantity);
    }
    for (const e of allEvents) expect(e.seatsSold).toBe(held.get(e.id) ?? 0);
    expect(allEvents.filter((e) => e.seatsSold === e.totalSeats).length).toBeGreaterThanOrEqual(1);
  });
});
