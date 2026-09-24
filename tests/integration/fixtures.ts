// Shared fixtures for the SQLite integration lane. Real database, real
// migrations, no mocks — each test gets its own in-memory database.
import { createMemoryDb, type Db } from "../../src/db/client";
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

export function addCode(db: Db, code: string, percent: number, over: Partial<typeof discountCodes.$inferInsert> = {}) {
  db.insert(discountCodes).values({ code, percent, createdAtMs: NOW - DAY, ...over }).run();
}

let keys = 0;

/** A clock-controllable shop over one database and one payment provider. */
export function shop(db: Db = createMemoryDb(), payments: PaymentProvider = createFakeStripe("sk_test_integration")) {
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
