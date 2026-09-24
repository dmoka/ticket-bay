// The demo seed must tell a consistent story: every stored amount is what the
// domain modules compute, and every event's seat count matches its orders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../../src/db/client";
import { discountCodes, events, orders } from "../../src/db/schema";
import { buildInvoice } from "../../src/domain/invoice";
import { previewCancellation } from "../../src/domain/cancellation";

let dir: string;
let db: Db;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticketbay-seed-"));
  const file = path.join(dir, "seed.db");
  execFileSync("npx", ["tsx", "scripts/seed.ts"], { env: { ...process.env, DATABASE_PATH: file }, stdio: "pipe" });
  db = openDb(file);
}, 60_000);

afterAll(() => {
  db?.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("db:seed", () => {
  it("creates 8 events, ~300 orders over 60 days, refunds and discount codes", () => {
    const os_ = db.select().from(orders).all();
    expect(db.select().from(events).all()).toHaveLength(8);
    expect(os_.length).toBeGreaterThanOrEqual(250);
    expect(os_.length).toBeLessThanOrEqual(400);
    expect(os_.filter((o) => o.status === "refunded").length).toBeGreaterThan(5);
    expect(db.select().from(discountCodes).all().length).toBeGreaterThanOrEqual(3);
    const span = Math.max(...os_.map((o) => o.createdAtMs)) - Math.min(...os_.map((o) => o.createdAtMs));
    expect(span).toBeGreaterThan(50 * 86_400_000);
  });

  it("stores exactly what the invoice and refund modules compute", () => {
    const evs = new Map(db.select().from(events).all().map((e) => [e.id, e]));
    for (const o of db.select().from(orders).all()) {
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
    for (const o of db.select().from(orders).all()) {
      if (o.status === "paid" || o.seatsReleased === false) held.set(o.eventId, (held.get(o.eventId) ?? 0) + o.quantity);
    }
    const all = db.select().from(events).all();
    for (const e of all) expect(e.seatsSold).toBe(held.get(e.id) ?? 0);
    expect(all.filter((e) => e.seatsSold === e.totalSeats).length).toBeGreaterThanOrEqual(1);
  });
});
