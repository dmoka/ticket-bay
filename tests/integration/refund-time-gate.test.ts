// Integration tests for the refund CUT-OFF against REAL Postgres (Testcontainers).
//
// src/refund.ts:16-17 states the rule as a business rule, not a suggestion:
//   "cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// The rest of the suite only ever evaluates the clock strictly before that moment
// (tests/integration/refund-persistence.test.ts:42 subtracts an hour; the property
// lane wraps every clock in `strictlyBefore`). These tests stand on the other side
// of the boundary, where the money actually leaks.
//
// Every order is written to the database and read back first, so the cut-off is
// compared against the eventStartMs Postgres returned — a BIGINT that arrives as a
// string and is coerced in getOrder (src/orders-repo.ts:46) — not against a literal.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder, markRefunded } from "../../src/orders-repo";
import { calculateRefund, netRefund, Order } from "../../src/refund";

let container: StartedPostgreSqlContainer;
let db: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Client({ connectionString: container.getConnectionUri() });
  await db.connect();
}, 120000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

// Fresh schema for every test — no row survives from one test to the next.
beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

/** Persist an order and read it back, so assertions run on what the database returned. */
async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

const EVENT_START = 1_800_000_000_000; // 2027-01-15, stored in a BIGINT column
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});

describe("refunds close when the event starts (real Postgres)", () => {
  it("still refunds in full one millisecond before the stored event start", async () => {
    // The boundary is exclusive on this side: the last instant before the event
    // is still a full refund. Pinned so a fix to the cut-off cannot overshoot
    // and start swallowing legitimate pre-event cancellations.
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(10_000);
    expect(netRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(9_800);
  });

  it("refunds nothing at the exact moment the stored event starts", async () => {
    // "From `eventStartMs` on" — the boundary instant itself is closed.
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
  });

  it("refunds nothing one millisecond after the stored event starts", async () => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + 1)).toBe(0);
    expect(netRefund(loaded, 4, loaded.eventStartMs + 1)).toBe(0);
  });

  it("refunds nothing long after the event is over", async () => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + 30 * DAY)).toBe(0);
    expect(netRefund(loaded, 4, loaded.eventStartMs + 30 * DAY)).toBe(0);
  });

  it("refunds nothing for an event that had already happened by the real wall clock", async () => {
    // The realistic case: a concert last month, a refund requested today.
    const loaded = await roundTrip(anOrder({ eventStartMs: Date.now() - 30 * DAY }));

    expect(calculateRefund(loaded, 4, Date.now())).toBe(0);
    expect(netRefund(loaded, 4, Date.now())).toBe(0);
  });

  it("closes partial cancellations after the event too, not just whole orders", async () => {
    const loaded = await roundTrip(anOrder());

    for (const cancelled of [1, 2, 3, 4]) {
      expect(calculateRefund(loaded, cancelled, loaded.eventStartMs)).toBe(0);
      expect(netRefund(loaded, cancelled, loaded.eventStartMs)).toBe(0);
    }
  });

  it("closes refunds after the event whatever the stored order looks like", async () => {
    const shapes: Order[] = [
      anOrder({ totalCents: 1, tickets: 1 }),
      anOrder({ totalCents: 10_001, tickets: 3 }),
      anOrder({ totalCents: 150, tickets: 300 }),
      anOrder({ totalCents: 999_983, tickets: 7, discountPercent: 15 }),
      anOrder({ totalCents: 2_147_483_647, tickets: 3 }),
    ];

    for (const shape of shapes) {
      const loaded = await roundTrip(shape);
      expect(calculateRefund(loaded, loaded.tickets, loaded.eventStartMs)).toBe(0);
      expect(netRefund(loaded, loaded.tickets, loaded.eventStartMs)).toBe(0);
    }
  });

  it("applies the cut-off to the stored event start, not to a stale in-memory copy", async () => {
    // An order whose event start only exists in the database: the caller holds an
    // id, loads the row, and the loaded BIGINT is what the cut-off must honour.
    const id = await saveOrder(db, anOrder({ eventStartMs: EVENT_START }));
    const loaded = (await getOrder(db, id))!;

    expect(loaded.eventStartMs).toBe(EVENT_START);
    expect(calculateRefund(loaded, loaded.tickets, EVENT_START + HOUR)).toBe(0);
  });
});

describe("the cut-off discriminates, it does not just return zero (real Postgres)", () => {
  // A gate that returned 0 unconditionally would satisfy every assertion above.
  // These tests fail against that, and against a gate that lost precision on the
  // BIGINT the driver handed back.
  it("separates two adjacent milliseconds around the stored event start", async () => {
    const loaded = await roundTrip(anOrder());

    const lastOpen = calculateRefund(loaded, 4, loaded.eventStartMs - 1);
    const firstClosed = calculateRefund(loaded, 4, loaded.eventStartMs);

    expect(lastOpen).toBe(10_000);
    expect(firstClosed).toBe(0);
    expect(lastOpen).not.toBe(firstClosed);
  });

  it("still pays every open refund it used to pay", async () => {
    // Guards the other direction: the fix must not have bought its zeros by
    // closing refunds that are legitimately still open.
    const shapes: Array<[Order, number]> = [
      [anOrder({ totalCents: 1, tickets: 1 }), 1],
      [anOrder({ totalCents: 10_001, tickets: 3 }), 10_001],
      [anOrder({ totalCents: 999_983, tickets: 7, discountPercent: 15 }), 999_983],
      [anOrder({ totalCents: 2_147_483_647, tickets: 3 }), 2_147_483_647],
    ];

    for (const [shape, expected] of shapes) {
      const loaded = await roundTrip(shape);
      expect(calculateRefund(loaded, loaded.tickets, loaded.eventStartMs - 1)).toBe(expected);
      expect(calculateRefund(loaded, loaded.tickets, loaded.eventStartMs - 1)).toBeGreaterThan(0);
    }
  });

  it("holds the boundary at the largest event start BIGINT can round-trip", async () => {
    // If the cut-off compared anything less precise than the exact millisecond,
    // these two adjacent values would collapse into each other up here.
    const loaded = await roundTrip(anOrder({ eventStartMs: Number.MAX_SAFE_INTEGER }));

    expect(loaded.eventStartMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("keeps the boundary where the database put it, not where the caller guessed", async () => {
    // Two orders one millisecond apart in the database. The same clock is open
    // for one and closed for the other, so the comparison must be reading each
    // row's own stored value.
    const earlier = await roundTrip(anOrder({ eventStartMs: EVENT_START }));
    const later = await roundTrip(anOrder({ eventStartMs: EVENT_START + 1 }));

    expect(calculateRefund(earlier, 4, EVENT_START)).toBe(0);
    expect(calculateRefund(later, 4, EVENT_START)).toBe(10_000);
  });
});

describe("the money path for a late refund request (real Postgres)", () => {
  it("moves no money when the refund is claimed after the event started", async () => {
    // Exactly what a refund endpoint does: take the exactly-once guard, then pay
    // out what the domain says is owed. After the event, that is nothing.
    const order = anOrder();
    const id = await saveOrder(db, order);
    const loaded = (await getOrder(db, id))!;

    const wonTheGuard = await markRefunded(db, id);
    const payout = wonTheGuard ? netRefund(loaded, loaded.tickets, loaded.eventStartMs + HOUR) : 0;

    expect(wonTheGuard).toBe(true);
    expect(payout).toBe(0);
  });

  it("does not let a customer who attended the event claim the ticket price back", async () => {
    // Event started an hour ago; the customer used the seat. The platform keeps
    // the money — otherwise every attendee can cancel on the way out.
    const loaded = await roundTrip(anOrder({ totalCents: 25_000, tickets: 5 }));
    const afterTheGig = loaded.eventStartMs + HOUR;

    expect(netRefund(loaded, 5, afterTheGig)).toBe(0);
  });

  it("keeps the platform whole across a batch of post-event claims", async () => {
    const shapes = [anOrder(), anOrder({ totalCents: 50_000, tickets: 10 }), anOrder({ totalCents: 7_777, tickets: 3 })];

    let paidOut = 0;
    for (const shape of shapes) {
      const loaded = await roundTrip(shape);
      paidOut += netRefund(loaded, loaded.tickets, loaded.eventStartMs + DAY);
    }

    expect(paidOut).toBe(0);
  });
});
