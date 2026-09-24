// Shared fixtures for the Postgres integration lane. Real database, real
// migrations, no mocks — each test file gets its own database (database.ts).
import type { Db } from "../../src/db/client";
import { createEvent } from "../../src/db/events-repo";
import { discountCodes } from "../../src/db/schema";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { placeOrder, cancelOrder, type Deps } from "../../src/services/orders";

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The old demo venue: 100 seats, 40 sold, €50.00, ten days out (no early-bird). */
export function venue(db: Db, over: Partial<Parameters<typeof createEvent>[1]> = {}) {
  return createEvent(db, {
    id: `ev-${Math.random().toString(36).slice(2, 8)}`,
    name: "RockFest 2026",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    startsAtMs: NOW + 10 * DAY,
    totalSeats: 100,
    seatsSold: 40,
    priceCents: 5000,
    createdAtMs: NOW - 30 * DAY,
    ...over,
  });
}

export async function addCode(db: Db, code: string, percent: number, over: Partial<typeof discountCodes.$inferInsert> = {}) {
  await db.insert(discountCodes).values({ code, percent, createdAtMs: NOW - DAY, ...over });
}

let keys = 0;

/** A clock-controllable shop over one database and one payment provider. */
export function shop(db: Db, payments: PaymentProvider = createFakeStripe("sk_test_integration")) {
  let nowMs = NOW;
  const deps = (): Deps => ({ db, payments, nowMs });
  return {
    db,
    payments,
    setClock(ms: number) {
      nowMs = ms;
    },
    book(eventId: string, quantity: number, extra: { code?: string; idempotencyKey?: string; email?: string } = {}) {
      return placeOrder(deps(), {
        eventId,
        quantity,
        email: extra.email ?? "fan@example.com",
        name: "A Fan",
        code: extra.code,
        idempotencyKey: extra.idempotencyKey ?? `key-${++keys}`,
      });
    },
    cancel(orderId: number) {
      return cancelOrder(deps(), orderId);
    },
  };
}

/**
 * A payment provider whose charges all complete together, once `n` of them are
 * in flight. Two checkouts then leave the charge step at the same moment and
 * reach their database transactions side by side — the interleaving a real
 * race needs, instead of whichever order the event loop happens to pick.
 */
export function chargesTogether(n: number, inner: PaymentProvider = createFakeStripe("sk_test_integration")): PaymentProvider {
  let waiting = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return {
    ...inner,
    async charge(input) {
      const charge = await inner.charge(input);
      if (++waiting >= n) release();
      await all;
      return charge;
    },
    refund: (...args) => inner.refund(...args),
    getCharge: (id) => inner.getCharge(id),
  };
}

/**
 * The Postgres error behind a failed query. Drizzle wraps driver errors
 * ("Failed query: ..."), so assert on the cause: its message and the name of
 * the constraint that refused the row.
 */
export async function pgError(p: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause ?? e;
    const { message, code, constraint } = cause as { message: string; code?: string; constraint?: string };
    return { message, code, constraint };
  }
  throw new Error("expected the query to fail");
}
