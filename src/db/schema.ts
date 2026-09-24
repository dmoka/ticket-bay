import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Money is INTEGER cents everywhere. Instants are INTEGER ms since epoch.
// No REAL columns: a float in a money path is a bug waiting for a total.

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category", { enum: ["concert", "festival", "conference", "comedy"] }).notNull(),
    venue: text("venue").notNull(),
    city: text("city").notNull(),
    description: text("description").notNull().default(""),
    startsAtMs: integer("starts_at_ms").notNull(),
    totalSeats: integer("total_seats").notNull(),
    seatsSold: integer("seats_sold").notNull().default(0),
    priceCents: integer("price_cents").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    check("events_seats_in_range", sql`${t.seatsSold} >= 0 AND ${t.seatsSold} <= ${t.totalSeats}`),
    check("events_price_non_negative", sql`${t.priceCents} >= 0`),
    // SQLite's INTEGER affinity quietly keeps 12.5 as a REAL. Refuse it.
    check("events_integer_money", sql`typeof(${t.priceCents}) = 'integer' AND typeof(${t.startsAtMs}) = 'integer'`),
  ],
);

export const discountCodes = sqliteTable(
  "discount_codes",
  {
    code: text("code").primaryKey(),
    percent: integer("percent").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAtMs: integer("expires_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [check("discount_codes_percent_range", sql`${t.percent} BETWEEN 1 AND 100`)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name").notNull(),
    quantity: integer("quantity").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountPercent: integer("discount_percent").notNull(),
    groupPercent: integer("group_percent").notNull().default(0),
    earlyBirdPercent: integer("early_bird_percent").notNull().default(0),
    codePercent: integer("code_percent").notNull().default(0),
    discountCode: text("discount_code").references(() => discountCodes.code),
    discountCents: integer("discount_cents").notNull(),
    /** discounted ticket amount — the refundable part of the order */
    ticketsCents: integer("tickets_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    /** what was charged: ticketsCents + feeCents */
    totalCents: integer("total_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    status: text("status", { enum: ["paid", "refunded"] }).notNull().default("paid"),
    paymentId: text("payment_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAtMs: integer("created_at_ms").notNull(),
    refundedAtMs: integer("refunded_at_ms"),
    /** net amount returned to the customer */
    refundCents: integer("refund_cents"),
    /** fee kept by the platform on the refund */
    refundFeeCents: integer("refund_fee_cents"),
    seatsReleased: integer("seats_released", { mode: "boolean" }),
    refundId: text("refund_id"),
  },
  (t) => [
    index("orders_event_idx").on(t.eventId),
    index("orders_email_idx").on(t.customerEmail),
    index("orders_created_idx").on(t.createdAtMs),
    check("orders_quantity_positive", sql`${t.quantity} > 0`),
    check("orders_money_non_negative", sql`${t.ticketsCents} >= 0 AND ${t.totalCents} >= 0`),
    check(
      "orders_integer_money",
      sql`typeof(${t.subtotalCents}) = 'integer' AND typeof(${t.discountCents}) = 'integer' AND typeof(${t.ticketsCents}) = 'integer' AND typeof(${t.feeCents}) = 'integer' AND typeof(${t.totalCents}) = 'integer' AND typeof(${t.vatCents}) = 'integer' AND (${t.refundCents} IS NULL OR typeof(${t.refundCents}) = 'integer')`,
    ),
    check("orders_refund_not_above_paid", sql`${t.refundCents} IS NULL OR ${t.refundCents} <= ${t.ticketsCents}`),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type OrderRow = typeof orders.$inferSelect;
export type DiscountCodeRow = typeof discountCodes.$inferSelect;
