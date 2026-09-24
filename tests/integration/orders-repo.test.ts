// The orders table against a REAL SQLite database: fidelity of money columns,
// the constraints that keep a float out of a cents column, and the
// exactly-once refund guard — including across two real connections.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryDb, migrateDb, openDb, type Db } from "../../src/db/client";
import { getOrder, insertOrder, isRefunded, markRefunded, toDomainOrder, type NewOrder } from "../../src/db/orders-repo";
import { adjustSeatsSold, getEvent } from "../../src/db/events-repo";
import { calculateRefund, netRefund } from "../../src/domain/refund";
import { NOW, HOUR, venue } from "./fixtures";

let db: Db;
let eventId: string;
let n = 0;

beforeEach(() => {
  db = createMemoryDb();
  eventId = venue(db).id;
});

const anOrder = (over: Partial<NewOrder> = {}): NewOrder => ({
  eventId,
  customerEmail: "fan@example.com",
  customerName: "A Fan",
  quantity: 2,
  subtotalCents: 10_000,
  discountPercent: 0,
  discountCents: 0,
  ticketsCents: 10_000,
  feeCents: 300,
  totalCents: 10_300,
  vatCents: 2_190,
  paymentId: "ch_test",
  idempotencyKey: `k-${++n}`,
  createdAtMs: NOW,
  ...over,
});

const refund = { atMs: NOW, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true };

describe("orders round-trip (real SQLite)", () => {
  it("returns every money field exactly as stored, as numbers", () => {
    const o = insertOrder(db, anOrder());
    const loaded = getOrder(db, o.id)!;
    expect(loaded).toEqual(o);
    expect(typeof loaded.ticketsCents).toBe("number");
    expect(loaded.status).toBe("paid");
  });

  it("holds the largest total the refund module admits, without loss", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const o = insertOrder(db, anOrder({ subtotalCents: big, ticketsCents: big, totalCents: big, quantity: 3 }));
    const loaded = getOrder(db, o.id)!;
    expect(loaded.ticketsCents).toBe(big);
    expect(Number.isSafeInteger(loaded.ticketsCents)).toBe(true);
    const ev = getEvent(db, eventId)!;
    expect(calculateRefund(toDomainOrder(loaded, ev), 3, ev.startsAtMs - HOUR)).toBe(big);
  });

  it("returns undefined for a missing order", () => {
    expect(getOrder(db, 999_999)).toBeUndefined();
  });

  it("maps a stored order onto the refund module's view: tickets paid, not the fee", () => {
    const o = insertOrder(db, anOrder());
    const ev = getEvent(db, eventId)!;
    expect(toDomainOrder(o, ev)).toEqual({ totalCents: 10_000, tickets: 2, discountPercent: 0, eventStartMs: ev.startsAtMs });
    expect(netRefund(toDomainOrder(o, ev), 2, ev.startsAtMs - 1)).toBe(9_800);
  });
});

describe("the database refuses what the money path refuses (real SQLite)", () => {
  it("refuses a fractional cent before it reaches SQL, naming the field", () => {
    expect(() => insertOrder(db, anOrder({ totalCents: 10_300.5 }))).toThrow("totalCents must be a safe integer");
  });

  it("refuses NaN, which SQLite would otherwise store as NULL", () => {
    expect(() => insertOrder(db, anOrder({ ticketsCents: Number.NaN }))).toThrow(RangeError);
  });

  it("has a CHECK that keeps a REAL out of a cents column even when the guard is bypassed", () => {
    // Straight through the driver, the way a hand-written script would.
    const raw = db.$client.prepare(`INSERT INTO orders (event_id, customer_email, customer_name, quantity, subtotal_cents,
      discount_percent, discount_cents, tickets_cents, fee_cents, total_cents, vat_cents, payment_id, idempotency_key,
      created_at_ms) VALUES (?, 'x@y.z', 'X', 1, 5000, 0, 0, 5000, 150, ?, 1095, 'ch', ?, ?)`);
    expect(() => raw.run(eventId, 5150.5, "raw-1", NOW)).toThrow(/CHECK constraint failed: orders_integer_money/);
    expect(() => raw.run(eventId, 5150, "raw-2", NOW)).not.toThrow();
  });

  it("refuses to record a refund larger than what was paid for the tickets", () => {
    const o = insertOrder(db, anOrder());
    expect(() => markRefunded(db, o.id, { ...refund, refundCents: 10_001 })).toThrow(/CHECK constraint failed/);
    expect(isRefunded(db, o.id)).toBe(false);
  });

  it("refuses a zero or negative ticket count", () => {
    expect(() => insertOrder(db, anOrder({ quantity: 0 }))).toThrow(/CHECK constraint failed/);
  });

  it("refuses to oversell: seats_sold can never exceed capacity", () => {
    expect(() => adjustSeatsSold(db, eventId, 61)).toThrow(/CHECK constraint failed/);
    adjustSeatsSold(db, eventId, 60);
    expect(getEvent(db, eventId)!.seatsSold).toBe(100);
  });

  it("refuses to release more seats than were sold", () => {
    expect(() => adjustSeatsSold(db, eventId, -41)).toThrow(/CHECK constraint failed/);
  });

  it("refuses a second order with the same idempotency key", () => {
    insertOrder(db, anOrder({ idempotencyKey: "same" }));
    expect(() => insertOrder(db, anOrder({ idempotencyKey: "same" }))).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses an order for an event that does not exist", () => {
    expect(() => insertOrder(db, anOrder({ eventId: "no-such-event" }))).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("marking an order refunded (real SQLite)", () => {
  it("succeeds the first time and refuses every later attempt", () => {
    const o = insertOrder(db, anOrder());
    expect(isRefunded(db, o.id)).toBe(false);
    expect(markRefunded(db, o.id, refund)).toBe(true);
    for (let i = 0; i < 3; i++) expect(markRefunded(db, o.id, refund)).toBe(false);
    expect(isRefunded(db, o.id)).toBe(true);
  });

  it("does not disturb the stored order fields, and records the refund", () => {
    const o = insertOrder(db, anOrder());
    markRefunded(db, o.id, refund);
    const after = getOrder(db, o.id)!;
    expect({ ...after, status: "paid", refundedAtMs: null, refundCents: null, refundFeeCents: null, seatsReleased: null }).toEqual(o);
    expect(after).toMatchObject({ status: "refunded", refundedAtMs: NOW, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true });
  });

  it("refuses to refund an order that does not exist", () => {
    expect(markRefunded(db, 424_242, refund)).toBe(false);
  });

  it("refunds only the order asked for", () => {
    const a = insertOrder(db, anOrder());
    const b = insertOrder(db, anOrder());
    markRefunded(db, a.id, refund);
    expect(isRefunded(db, b.id)).toBe(false);
  });

  it("does not lose the refund when its transaction rolls back", () => {
    const o = insertOrder(db, anOrder());
    expect(() =>
      db.transaction((tx) => {
        expect(markRefunded(tx, o.id, refund)).toBe(true);
        throw new Error("payment provider down");
      }),
    ).toThrow("payment provider down");
    // The refund never committed, so no money moved — the order must still be refundable.
    expect(isRefunded(db, o.id)).toBe(false);
    expect(markRefunded(db, o.id, refund)).toBe(true);
  });
});

describe("two real connections racing for one refund (SQLite file)", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lets exactly one connection win, and the loser sees the winner's commit", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticketbay-"));
    const file = path.join(dir, "race.db");
    const a = openDb(file);
    migrateDb(a);
    const b = openDb(file);
    eventId = venue(a).id;
    const o = insertOrder(a, anOrder());

    const wins = [a, b, a, b].map((conn) => markRefunded(conn, o.id, refund));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(isRefunded(b, o.id)).toBe(true);
    // The payout decision follows the guard: exactly one refund is paid.
    const paid = wins.reduce((s, won) => s + (won ? refund.refundCents : 0), 0);
    expect(paid).toBe(9_800);
  });
});

describe("migrations (real SQLite)", () => {
  it("can be applied twice without error or data loss", () => {
    const o = insertOrder(db, anOrder());
    migrateDb(db);
    expect(getOrder(db, o.id)).toEqual(o);
  });
});
