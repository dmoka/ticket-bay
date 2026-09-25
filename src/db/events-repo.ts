import { asc, eq, sql } from "drizzle-orm";
import type { Event } from "../domain/booking";
import type { DbLike } from "./client";
import { events, type EventRow, type NewEventRow } from "./schema";

/** The domain's view of an event row. */
export function toDomainEvent(row: EventRow): Event {
  return {
    id: row.id,
    name: row.name,
    totalSeats: row.totalSeats,
    seatsSold: row.seatsSold,
    priceCents: row.priceCents,
    startMs: row.startsAtMs,
  };
}

export async function listEvents(db: DbLike): Promise<EventRow[]> {
  return db.select().from(events).orderBy(asc(events.startsAtMs));
}

export async function getEvent(db: DbLike, id: string): Promise<EventRow | undefined> {
  const [row] = await db.select().from(events).where(eq(events.id, id));
  return row;
}

/**
 * Reads the event and holds its row lock until the transaction ends. Two
 * checkouts for the same event queue up here, so the second one re-checks
 * capacity against the first one's committed seat count.
 */
export async function getEventForUpdate(tx: DbLike, id: string): Promise<EventRow | undefined> {
  const [row] = await tx.select().from(events).where(eq(events.id, id)).for("update");
  return row;
}

export async function createEvent(db: DbLike, row: NewEventRow): Promise<EventRow> {
  const [created] = await db.insert(events).values(row).returning();
  return created;
}

/** Moves `delta` seats in or out of the sold count. The CHECK constraint refuses an oversell. */
export async function adjustSeatsSold(db: DbLike, id: string, delta: number): Promise<void> {
  await db
    .update(events)
    .set({ seatsSold: sql`${events.seatsSold} + ${delta}` })
    .where(eq(events.id, id));
}

export async function markEventCancelled(tx: DbLike, id: string, atMs: number): Promise<void> {
  await tx.update(events).set({ cancelledAtMs: atMs }).where(eq(events.id, id));
}
