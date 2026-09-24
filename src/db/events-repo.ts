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

export function listEvents(db: DbLike): EventRow[] {
  return db.select().from(events).orderBy(asc(events.startsAtMs)).all();
}

export function getEvent(db: DbLike, id: string): EventRow | undefined {
  return db.select().from(events).where(eq(events.id, id)).get();
}

export function createEvent(db: DbLike, row: NewEventRow): EventRow {
  return db.insert(events).values(row).returning().get();
}

/** Moves `delta` seats in or out of the sold count. The CHECK constraint refuses an oversell. */
export function adjustSeatsSold(db: DbLike, id: string, delta: number): void {
  db.update(events)
    .set({ seatsSold: sql`${events.seatsSold} + ${delta}` })
    .where(eq(events.id, id))
    .run();
}
