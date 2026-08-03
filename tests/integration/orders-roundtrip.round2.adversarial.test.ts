// Adversarial lane, round 2: attacking the schema widening.
//
// src/orders-repo.ts:23-24 moved `discount_percent` and `event_start_ms` from
// INTEGER/BIGINT to DOUBLE PRECISION, with the claim (src/orders-repo.ts:20-22)
// that "float8 is the same IEEE-754 double the domain already uses, so nothing
// is rounded on the way in or out."
//
// That claim is worth checking rather than believing, because it has to survive
// the pg driver's text encoding on the way in AND Postgres's float8 text output
// on the way out. It also has a second edge nobody asked about: a wider column
// accepts MORE than the narrow one did, and some of what it now accepts is
// exactly what the domain refuses.
//
// Everything here runs against real Postgres via Testcontainers.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder } from "../../src/orders-repo";
import { bookTickets, Event } from "../../src/booking";
import { calculateRefund, Order } from "../../src/refund";

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

beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

const EVENT_START = 1_800_000_000_000;

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});

async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

// ---------------------------------------------------------------------------
// Fidelity: does float8 really hold what the domain admits, bit for bit?
// ---------------------------------------------------------------------------
describe("float8 holds every instant the domain admits, unchanged", () => {
  // `calculateRefund` accepts any FINITE eventStartMs (src/refund.ts:42), which
  // is a far wider range than a timestamp — including magnitudes BIGINT could
  // never have held, and denormals no integer column could express.
  // `Object.is` rather than `toBe`-on-numbers reasoning: a value that comes back
  // one ULP off is a different instant, and at the closing boundary a different
  // instant is a different answer about someone's money.
  it.each([
    ["the epoch", 0],
    ["one ms in", 1],
    ["pre-epoch", -1],
    ["a half-millisecond start", 1.5],
    ["a realistic start with a fractional ms", 1_700_000_000_000.5],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["past 2^53, where consecutive integers stop existing", 2 ** 53 + 2],
    ["2^60", 2 ** 60],
    ["the largest finite double", 1e308],
    ["the most negative finite double", -1e308],
    ["the smallest positive denormal", Number.MIN_VALUE],
    ["one machine epsilon", Number.EPSILON],
    ["deep pre-epoch", -Number.MAX_SAFE_INTEGER],
  ])("round-trips %s bit for bit", async (_label, eventStartMs) => {
    const loaded = await roundTrip(anOrder({ eventStartMs }));

    expect(Object.is(loaded.eventStartMs, eventStartMs)).toBe(true);
  });

  it.each([
    ["no discount", 0],
    ["everything off", 100],
    ["a third off", 33.33],
    ["a repeating third", 100 / 3],
    ["the classic float artefact", 0.1 + 0.2],
    ["one ULP below a whole percent", 99.99999999999999],
    ["a denormal discount", Number.MIN_VALUE],
    ["a vanishingly small discount", 1e-300],
  ])("round-trips a %s discount bit for bit", async (_label, discountPercent) => {
    const loaded = await roundTrip(anOrder({ discountPercent }));

    expect(Object.is(loaded.discountPercent, discountPercent)).toBe(true);
  });

  // A table of hand-picked values proves the cases someone thought of. This
  // proves the ones nobody thought of: 400 arbitrary doubles through the driver,
  // the column, and the text decoder on the way back.
  it("round-trips arbitrary doubles bit for bit, 400 of them", async () => {
    for (let i = 0; i < 400; i++) {
      const discountPercent = Math.random() * 100;
      const eventStartMs = (Math.random() - 0.5) * 4e12;

      const loaded = await roundTrip(anOrder({ discountPercent, eventStartMs }));

      expect(Object.is(loaded.discountPercent, discountPercent)).toBe(true);
      expect(Object.is(loaded.eventStartMs, eventStartMs)).toBe(true);
    }
  });

  // The money column was NOT widened, and must not have been disturbed.
  it("still round-trips the largest total the domain admits", async () => {
    const loaded = await roundTrip(anOrder({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 }));

    expect(loaded.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 3, loaded.eventStartMs - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ---------------------------------------------------------------------------
// The migration, against a database that predates it.
// ---------------------------------------------------------------------------
describe("the migration does not edit data that is already there", () => {
  /** The schema as it shipped before the widening. */
  async function oldSchema() {
    await db.query(`DROP TABLE IF EXISTS orders`);
    await db.query(`CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      total_cents BIGINT NOT NULL,
      tickets INTEGER NOT NULL,
      discount_percent INTEGER NOT NULL,
      event_start_ms BIGINT NOT NULL,
      refunded_at TIMESTAMPTZ)`);
  }

  // Every row this application could have written to the old schema held an
  // integer discount and an integer event start that came from a JS double, so
  // every one of them is exactly representable in float8. The ALTER must be a
  // pure type change, not a value change.
  it("preserves every row the old integer schema could hold", async () => {
    await oldSchema();
    await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 10, 1700000000000), ($1, 3, 100, $2), (1, 1, 0, -1)`,
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    );

    await initSchema(db);

    expect(await getOrder(db, 1)).toEqual({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 10,
      eventStartMs: 1_700_000_000_000,
    });
    expect(await getOrder(db, 2)).toEqual({
      totalCents: Number.MAX_SAFE_INTEGER,
      tickets: 3,
      discountPercent: 100,
      eventStartMs: Number.MAX_SAFE_INTEGER,
    });
    expect(await getOrder(db, 3)).toEqual({
      totalCents: 1,
      tickets: 1,
      discountPercent: 0,
      eventStartMs: -1,
    });
  });

  // A migration that only works once is a migration that fails on the second
  // deploy, or on any replica that already ran it.
  it("is idempotent — running it repeatedly changes nothing", async () => {
    await oldSchema();
    await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (12345, 7, 33, 1700000000000)`,
    );

    await initSchema(db);
    const once = await getOrder(db, 1);
    await initSchema(db);
    await initSchema(db);
    const thrice = await getOrder(db, 1);

    expect(thrice).toEqual(once);
    expect(thrice!.discountPercent).toBe(33);
  });

  // Widening must not narrow anything: an order saved through the new schema
  // still reads back through the same code path after a re-migration.
  it("keeps freshly written fractional values across a re-migration", async () => {
    const id = await saveOrder(db, anOrder({ discountPercent: 33.33, eventStartMs: EVENT_START + 0.5 }));

    await initSchema(db);

    const loaded = await getOrder(db, id);
    expect(Object.is(loaded!.discountPercent, 33.33)).toBe(true);
    expect(Object.is(loaded!.eventStartMs, EVENT_START + 0.5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the wider column now accepts that it should not.
// ---------------------------------------------------------------------------
describe("the database refuses what the refund path refuses", () => {
  // INVARIANT: a row that reaches the orders table must be an order the refund
  // path can still answer questions about. Anything else is a customer who paid,
  // whose order exists, and whose refund throws a RangeError forever — with no
  // signal at write time that anything went wrong.
  //
  // The old INTEGER/BIGINT columns enforced this by accident: `Infinity` and
  // `NaN` were rejected at insert with "invalid input syntax for type bigint".
  // float8 accepts both as first-class values, so the guard is gone. Verified:
  // the row lands, `event_start_ms` reads back as `Infinity`, and
  // `calculateRefund` then throws "event start out of range" on every call.
  //
  // Either resolution closes it: validate in `saveOrder`, or add a CHECK
  // constraint on the columns. What must not stand is a silent accept.
  it.each([
    ["an infinite event start", anOrder({ eventStartMs: Number.POSITIVE_INFINITY })],
    ["a negatively infinite event start", anOrder({ eventStartMs: Number.NEGATIVE_INFINITY })],
    ["a NaN event start", anOrder({ eventStartMs: Number.NaN })],
    ["a NaN discount", anOrder({ discountPercent: Number.NaN })],
    ["an infinite discount", anOrder({ discountPercent: Number.POSITIVE_INFINITY })],
  ])("refuses to store %s", async (_label, o) => {
    await expect(saveOrder(db, o)).rejects.toThrow();
  });

  // The same rule stated as an outcome rather than as an expectation about where
  // the refusal happens: whatever comes back out of the database has to be
  // answerable. This is the assertion that matters; the one above is how it
  // should be enforced.
  it("never returns a stored order that the refund path cannot answer", async () => {
    for (const o of [
      anOrder({ eventStartMs: Number.POSITIVE_INFINITY }),
      anOrder({ eventStartMs: Number.NaN }),
      anOrder({ discountPercent: Number.NaN }),
    ]) {
      let id: number;
      try {
        id = await saveOrder(db, o);
      } catch {
        continue; // refused at write time — correct.
      }
      const loaded = (await getOrder(db, id))!;
      expect(() => calculateRefund(loaded, loaded.tickets, 0)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The column the widening did not reach.
// ---------------------------------------------------------------------------
describe("tickets is the last column narrower than the domain", () => {
  // `calculateRefund` admits any integer ticket count above zero — the fast
  // suite exercises 1e300 (tests/refund.arithmetic.test.ts:106) — and
  // `bookTickets` will sell any count a venue has seats for. `tickets` is still
  // INT4, which stops at 2,147,483,647. This is the same domain/schema mismatch
  // as the fractional discount, on the one column the widening skipped.
  it("stores an order bookTickets was willing to sell", async () => {
    const hugeVenue: Event = {
      id: "arena",
      name: "The Very Large Arena",
      totalSeats: 3_000_000_000,
      seatsSold: 0,
      priceCents: 1,
      startMs: EVENT_START,
    };
    const sold = bookTickets(hugeVenue, 3_000_000_000, 0);
    // The domain is perfectly happy with it, before the database sees it.
    expect(sold.tickets).toBe(3_000_000_000);
    expect(calculateRefund(sold, sold.tickets, EVENT_START - 1)).toBe(3_000_000_000);

    const loaded = await roundTrip(sold);

    expect(loaded.tickets).toBe(3_000_000_000);
  });
});
