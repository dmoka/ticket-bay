// The e2e suite's dataset: small, fixed, and only what the specs read. Each
// event is the old demo venue — 100 seats, 40 already sold (60 left), €50.00.
import type { Db } from "../../src/db/client";
import { discountCodes, events } from "../../src/db/schema";
import { BOOKING_AT_MS, E2E_CODE, E2E_EVENTS, EVENT_START_MS } from "./env";

export async function seedE2E(db: Db): Promise<void> {
  await db.insert(events).values(
    Object.values(E2E_EVENTS).map((id) => ({
      id,
      name: `RockFest ${id.slice(4)}`,
      category: "concert" as const,
      venue: "Test Arena",
      city: "Budapest",
      description: "Seeded for the Playwright suite.",
      startsAtMs: EVENT_START_MS,
      totalSeats: 100,
      seatsSold: 40,
      priceCents: 5000,
      createdAtMs: BOOKING_AT_MS - 30 * 86_400_000,
    })),
  );
  await db.insert(discountCodes).values({ ...E2E_CODE, createdAtMs: BOOKING_AT_MS - 30 * 86_400_000 });
}
