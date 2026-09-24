// The orders table against a REAL Postgres (Testcontainers): fidelity of money
// columns, the constraints that keep a fraction out of a cents column, and the
// exactly-once refund guard — including across two real connections.
import { describe, it, expect, beforeEach } from "vitest";
import { closeDb, migrateDb, openDb } from "../../src/db/client";
import { getOrder, insertOrder, isRefunded, markRefunded, toDomainOrder, type NewOrder } from "../../src/db/orders-repo";
import { adjustSeatsSold, getEvent } from "../../src/db/events-repo";
import { calculateRefund, netRefund } from "../../src/domain/refund";
import { useTestDatabase } from "./database";
import { NOW, HOUR, pgError, venue } from "./fixtures";

const t = useTestDatabase();
let eventId: string;
let n = 0;

beforeEach(async () => {
  eventId = (await venue(t.db)).id;
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

describe("orders round-trip (real Postgres)", () => {
  it("returns every money field exactly as stored, as numbers", async () => {
    const o = await insertOrder(t.db, anOrder());
    const loaded = (await getOrder(t.db, o.id))!;
    expect(loaded).toEqual(o);
    // node-postgres hands BIGINT back as a string unless the column maps it.
    expect(typeof loaded.ticketsCents).toBe("number");
    expect(typeof loaded.createdAtMs).toBe("number");
    expect(loaded.status).toBe("paid");
  });

  it("holds the largest total the refund module admits, without loss", async () => {
    const big = Number.MAX_SAFE_INTEGER;
    const o = await insertOrder(t.db, anOrder({ subtotalCents: big, ticketsCents: big, totalCents: big, quantity: 3 }));
    const loaded = (await getOrder(t.db, o.id))!;
    expect(loaded.ticketsCents).toBe(big);
    expect(Number.isSafeInteger(loaded.ticketsCents)).toBe(true);
    const ev = (await getEvent(t.db, eventId))!;
    expect(calculateRefund(toDomainOrder(loaded, ev), 3, ev.startsAtMs - HOUR)).toBe(big);
  });

  it("returns undefined for a missing order", async () => {
    expect(await getOrder(t.db, 999_999)).toBeUndefined();
  });

  it("maps a stored order onto the refund module's view: tickets paid, not the fee", async () => {
    const o = await insertOrder(t.db, anOrder());
    const ev = (await getEvent(t.db, eventId))!;
    expect(toDomainOrder(o, ev)).toEqual({ totalCents: 10_000, tickets: 2, discountPercent: 0, eventStartMs: ev.startsAtMs });
    expect(netRefund(toDomainOrder(o, ev), 2, ev.startsAtMs - 1)).toBe(9_800);
  });
});

describe("the database refuses what the money path refuses (real Postgres)", () => {
  it("refuses a fractional cent before it reaches SQL, naming the field", async () => {
    await expect(insertOrder(t.db, anOrder({ totalCents: 10_300.5 }))).rejects.toThrow("totalCents must be a safe integer");
  });

  it("refuses NaN before it reaches SQL", async () => {
    await expect(insertOrder(t.db, anOrder({ ticketsCents: Number.NaN }))).rejects.toThrow(RangeError);
  });

  it("has BIGINT cents columns that refuse a fraction even when the guard is bypassed", async () => {
    // Straight through the driver, the way a hand-written script would.
    const raw = (total: number, key: string) =>
      t.db.$client.query(
        `INSERT INTO orders (event_id, customer_email, customer_name, quantity, subtotal_cents, discount_percent,
          discount_cents, tickets_cents, fee_cents, total_cents, vat_cents, payment_id, idempotency_key, created_at_ms)
         VALUES ($1, 'x@y.z', 'X', 1, 5000, 0, 0, 5000, 150, $2, 1095, 'ch', $3, $4)`,
        [eventId, total, key, NOW],
      );
    await expect(raw(5150.5, "raw-1")).rejects.toThrow(/invalid input syntax for type bigint: "5150.5"/);
    await expect(raw(5150, "raw-2")).resolves.toBeDefined();
  });

  it("refuses to record a refund larger than what was paid for the tickets", async () => {
    const o = await insertOrder(t.db, anOrder());
    expect((await pgError(markRefunded(t.db, o.id, { ...refund, refundCents: 10_001 }))).constraint).toBe("orders_refund_not_above_paid");
    expect(await isRefunded(t.db, o.id)).toBe(false);
  });

  it("refuses a zero or negative ticket count", async () => {
    expect((await pgError(insertOrder(t.db, anOrder({ quantity: 0 })))).constraint).toBe("orders_quantity_positive");
  });

  it("refuses to oversell: seats_sold can never exceed capacity", async () => {
    expect((await pgError(adjustSeatsSold(t.db, eventId, 61))).constraint).toBe("events_seats_in_range");
    await adjustSeatsSold(t.db, eventId, 60);
    expect((await getEvent(t.db, eventId))!.seatsSold).toBe(100);
  });

  it("refuses to release more seats than were sold", async () => {
    expect((await pgError(adjustSeatsSold(t.db, eventId, -41))).constraint).toBe("events_seats_in_range");
  });

  it("refuses a second order with the same idempotency key", async () => {
    await insertOrder(t.db, anOrder({ idempotencyKey: "same" }));
    expect((await pgError(insertOrder(t.db, anOrder({ idempotencyKey: "same" })))).constraint).toBe("orders_idempotency_key_unique");
  });

  it("refuses an order for an event that does not exist", async () => {
    const err = await pgError(insertOrder(t.db, anOrder({ eventId: "no-such-event" })));
    expect(err.message).toMatch(/violates foreign key constraint/);
    expect(err.constraint).toBe("orders_event_id_events_id_fk");
  });
});

describe("marking an order refunded (real Postgres)", () => {
  it("succeeds the first time and refuses every later attempt", async () => {
    const o = await insertOrder(t.db, anOrder());
    expect(await isRefunded(t.db, o.id)).toBe(false);
    expect(await markRefunded(t.db, o.id, refund)).toBe(true);
    for (let i = 0; i < 3; i++) expect(await markRefunded(t.db, o.id, refund)).toBe(false);
    expect(await isRefunded(t.db, o.id)).toBe(true);
  });

  it("does not disturb the stored order fields, and records the refund", async () => {
    const o = await insertOrder(t.db, anOrder());
    await markRefunded(t.db, o.id, refund);
    const after = (await getOrder(t.db, o.id))!;
    expect({ ...after, status: "paid", refundedAtMs: null, refundCents: null, refundFeeCents: null, seatsReleased: null }).toEqual(o);
    expect(after).toMatchObject({ status: "refunded", refundedAtMs: NOW, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true });
  });

  it("refuses to refund an order that does not exist", async () => {
    expect(await markRefunded(t.db, 424_242, refund)).toBe(false);
  });

  it("refunds only the order asked for", async () => {
    const a = await insertOrder(t.db, anOrder());
    const b = await insertOrder(t.db, anOrder());
    await markRefunded(t.db, a.id, refund);
    expect(await isRefunded(t.db, b.id)).toBe(false);
  });

  it("does not lose the refund when its transaction rolls back", async () => {
    const o = await insertOrder(t.db, anOrder());
    await expect(
      t.db.transaction(async (tx) => {
        expect(await markRefunded(tx, o.id, refund)).toBe(true);
        throw new Error("payment provider down");
      }),
    ).rejects.toThrow("payment provider down");
    // The refund never committed, so no money moved — the order must still be refundable.
    expect(await isRefunded(t.db, o.id)).toBe(false);
    expect(await markRefunded(t.db, o.id, refund)).toBe(true);
  });
});

describe("two real connections racing for one refund (Postgres row locks)", () => {
  it("lets exactly one connection win, and the loser sees the winner's commit", async () => {
    const a = openDb(t.url);
    const b = openDb(t.url);
    try {
      const o = await insertOrder(a, anOrder());
      // Four concurrent UPDATEs over two pools: the first takes the row lock,
      // the rest wait for it, then re-check `status = 'paid'` and match nothing.
      const wins = await Promise.all([a, b, a, b].map((conn) => markRefunded(conn, o.id, refund)));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await isRefunded(b, o.id)).toBe(true);
      // The payout decision follows the guard: exactly one refund is paid.
      const paid = wins.reduce((s, won) => s + (won ? refund.refundCents : 0), 0);
      expect(paid).toBe(9_800);
    } finally {
      await Promise.all([closeDb(a), closeDb(b)]);
    }
  });

  it("makes the second refund wait for the first one's transaction, then refuses it", async () => {
    const a = openDb(t.url);
    const b = openDb(t.url);
    try {
      const o = await insertOrder(a, anOrder());
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const aHasLock = new Promise<void>((r) => (locked = r));
      // A refunds inside a transaction and keeps it open...
      const first = a.transaction(async (tx) => {
        const won = await markRefunded(tx, o.id, refund);
        locked();
        await held;
        return won;
      });
      await aHasLock;
      // ...B tries meanwhile. It must block on A's row lock — not read the
      // still-'paid' row and win a second payout.
      let bDone = false;
      const second = markRefunded(b, o.id, refund).then((won) => {
        bDone = true;
        return won;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(bDone, "B must wait for A's row lock").toBe(false);
      release();
      expect(await first).toBe(true);
      expect(await second).toBe(false);
    } finally {
      await Promise.all([closeDb(a), closeDb(b)]);
    }
  });
});

describe("migrations (real Postgres)", () => {
  it("can be applied twice without error or data loss", async () => {
    const o = await insertOrder(t.db, anOrder());
    await migrateDb(t.db);
    expect(await getOrder(t.db, o.id)).toEqual(o);
  });
});
