import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

// Money is integer cents everywhere. Instants are integer ms since epoch.
// No numeric/real columns: a float in a money path is a bug waiting for a total.
//
// Cents and instants are BIGINT: an epoch in ms (1.8e12) and the largest total
// the refund module admits (Number.MAX_SAFE_INTEGER) both overflow INTEGER.
// `mode: "number"` hands them to JS as numbers, not strings — safe because
// every amount the app writes is checked with Number.isSafeInteger first.
const cents = (name: string) => bigint(name, { mode: "number" });
const instant = (name: string) => bigint(name, { mode: "number" });

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category", { enum: ["concert", "festival", "conference", "comedy"] }).notNull(),
    venue: text("venue").notNull(),
    city: text("city").notNull(),
    description: text("description").notNull().default(""),
    startsAtMs: instant("starts_at_ms").notNull(),
    totalSeats: integer("total_seats").notNull(),
    seatsSold: integer("seats_sold").notNull().default(0),
    priceCents: cents("price_cents").notNull(),
    createdAtMs: instant("created_at_ms").notNull(),
    /** set when an admin cancels the event: sales stop, every paid order is refunded */
    cancelledAtMs: instant("cancelled_at_ms"),
  },
  (t) => [
    check("events_seats_in_range", sql`${t.seatsSold} >= 0 AND ${t.seatsSold} <= ${t.totalSeats}`),
    check("events_price_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

export const discountCodes = pgTable(
  "discount_codes",
  {
    code: text("code").primaryKey(),
    percent: integer("percent").notNull(),
    active: boolean("active").notNull().default(true),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAtMs: instant("expires_at_ms"),
    createdAtMs: instant("created_at_ms").notNull(),
  },
  (t) => [check("discount_codes_percent_range", sql`${t.percent} BETWEEN 1 AND 100`)],
);

export const orders = pgTable(
  "orders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    /**
     * The account that booked. Every order placed through the app or the MCP
     * server has one; null only on rows from before accounts existed.
     */
    userId: text("user_id").references(() => user.id),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name").notNull(),
    quantity: integer("quantity").notNull(),
    subtotalCents: cents("subtotal_cents").notNull(),
    discountPercent: integer("discount_percent").notNull(),
    groupPercent: integer("group_percent").notNull().default(0),
    earlyBirdPercent: integer("early_bird_percent").notNull().default(0),
    codePercent: integer("code_percent").notNull().default(0),
    discountCode: text("discount_code").references(() => discountCodes.code),
    discountCents: cents("discount_cents").notNull(),
    /** discounted ticket amount — the refundable part of the order */
    ticketsCents: cents("tickets_cents").notNull(),
    feeCents: cents("fee_cents").notNull(),
    /** what was charged: ticketsCents + feeCents */
    totalCents: cents("total_cents").notNull(),
    vatCents: cents("vat_cents").notNull(),
    /** "refunded" once every ticket is cancelled; an order with tickets left is "paid" (see `refunds`) */
    status: text("status", { enum: ["paid", "refunded"] }).notNull().default("paid"),
    paymentId: text("payment_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAtMs: instant("created_at_ms").notNull(),
    // The refund columns below are from when an order could only be refunded
    // whole. Migration 0003 copied them into `refunds`; nothing reads or
    // writes them any more, and a later migration drops them.
    /** @deprecated read `refunds` */
    refundedAtMs: instant("refunded_at_ms"),
    /** @deprecated read `refunds` */
    refundCents: cents("refund_cents"),
    /** @deprecated read `refunds` */
    refundFeeCents: cents("refund_fee_cents"),
    /** @deprecated read `refunds` */
    seatsReleased: boolean("seats_released"),
    /** @deprecated read `refunds` */
    refundId: text("refund_id"),
    /** @deprecated read `refunds` */
    refundReason: text("refund_reason", { enum: ["customer", "event_cancelled"] }),
  },
  (t) => [
    index("orders_event_idx").on(t.eventId),
    index("orders_email_idx").on(t.customerEmail),
    index("orders_user_idx").on(t.userId),
    index("orders_created_idx").on(t.createdAtMs),
    check("orders_quantity_positive", sql`${t.quantity} > 0`),
    check("orders_money_non_negative", sql`${t.ticketsCents} >= 0 AND ${t.totalCents} >= 0`),
    check("orders_refund_not_above_paid", sql`${t.refundCents} IS NULL OR ${t.refundCents} <= ${t.ticketsCents}`),
  ],
);

/**
 * One row per cancellation: a customer giving back some (or all) of an
 * order's tickets, or the organiser cancelling the event. An order's refund
 * totals are the sums over its rows. A trigger (migration 0003) refuses any
 * row that would cancel more tickets than the order has, or take the gross
 * refunded on the order above its `tickets_cents`.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    /** tickets this cancellation gave back */
    tickets: integer("tickets").notNull(),
    /** this cancellation's share of the ticket money, before the fee */
    grossCents: cents("gross_cents").notNull(),
    /** refund fee kept by the platform */
    feeCents: cents("fee_cents").notNull(),
    /** what goes back to the customer: gross − fee */
    netCents: cents("net_cents").notNull(),
    /** the customer cancelled, or the organiser cancelled the event */
    reason: text("reason", { enum: ["customer", "event_cancelled"] }).notNull(),
    createdAtMs: instant("created_at_ms").notNull(),
    /** false for a cancel after the event started: the seats stay taken */
    seatsReleased: boolean("seats_released").notNull(),
    /**
     * One per cancellation, sent with the payout so a retry never pays twice.
     * "cancel-…" is the key the customer's cancel request came with (a resend
     * finds this row instead of cancelling again); the others are made here.
     */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** the payment provider's refund id; null until the payout went through (or when there is nothing to pay) */
    providerRefundId: text("provider_refund_id"),
  },
  (t) => [
    index("refunds_order_idx").on(t.orderId),
    index("refunds_created_idx").on(t.createdAtMs),
    check("refunds_tickets_positive", sql`${t.tickets} > 0`),
    check(
      "refunds_amounts_add_up",
      sql`${t.grossCents} >= 0 AND ${t.feeCents} >= 0 AND ${t.netCents} >= 0 AND ${t.netCents} + ${t.feeCents} = ${t.grossCents}`,
    ),
  ],
);

/**
 * One row per checkout in progress, keyed by its idempotency key. It lives
 * only while the card is being charged: claimed before, deleted after. A
 * second attempt with the same key waits for the claim to go away, then sees
 * the first attempt's outcome. Holding a row — not a database connection —
 * means a slow payment provider cannot tie up the connection pool.
 */
export const checkoutClaims = pgTable("checkout_claims", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  /** which attempt holds the claim: only it may book, void, or release */
  token: text("token").notNull(),
  /** by the database's clock, so app servers with skewed clocks agree */
  claimedAtMs: instant("claimed_at_ms").notNull(),
});

/**
 * Charges a checkout gave back because it booked nothing (sold out while the
 * card was charged, a code used up, …). Written BEFORE the provider refund, in
 * a transaction under the checkout key's lock; a booking takes the same lock
 * and refuses any charge listed here — so no order is ever placed on money
 * that is being returned, whichever attempt charged it.
 */
export const voidedCharges = pgTable("voided_charges", {
  chargeId: text("charge_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  voidedAtMs: instant("voided_at_ms").notNull(),
});

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
/** The columns 0003 copied into `refunds`: kept out of the row type so nothing reads them by mistake. */
type DeprecatedOrderColumns = "refundedAtMs" | "refundCents" | "refundFeeCents" | "seatsReleased" | "refundId" | "refundReason";
export type OrderRow = Omit<typeof orders.$inferSelect, DeprecatedOrderColumns>;
export type RefundRow = typeof refunds.$inferSelect;
export type DiscountCodeRow = typeof discountCodes.$inferSelect;
export type UserRow = typeof user.$inferSelect;
