// The e2e suite's dataset: small, fixed, and only what the specs read. Each
// event is the old demo venue — 100 seats, 40 already sold (60 left), €50.00.
// Accounts are created through Better Auth itself (it hashes the password),
// the same way scripts/seed.ts does it; admins then get the role.
import { eq } from "drizzle-orm";
import { createAuth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { discountCodes, events, user } from "../../src/db/schema";
import { BOOKING_AT_MS, E2E_AUTH_SECRET, E2E_BASE_URL, E2E_CODE, E2E_EVENTS, E2E_PASSWORD, E2E_USERS, EVENT_START_MS, type E2EUser } from "./env";

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

  const auth = createAuth(db, { baseURL: E2E_BASE_URL, secret: E2E_AUTH_SECRET });
  for (const u of Object.values(E2E_USERS) as E2EUser[]) {
    await auth.api.signUpEmail({ body: { name: u.name, email: u.email, password: E2E_PASSWORD } });
    if (u.admin) await db.update(user).set({ role: "admin" }).where(eq(user.email, u.email));
  }
}
