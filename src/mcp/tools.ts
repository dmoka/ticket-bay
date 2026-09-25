// TicketBay's MCP tools, defined once and served twice: over stdio by
// mcp/server.ts (public tools only, no auth) and over Streamable HTTP by
// app/api/mcp (public + private tools, the caller from their API key).
//
// The tools are thin: every rule — prices, discounts, seats, refunds — lives
// in src/domain and src/services, exactly as the web app uses it. A tool only
// validates input, calls the service, and shapes the answer for a model.
import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { cancelImpact } from "../db/admin-queries";
import type { Db } from "../db/client";
import { getEvent, listEvents, toDomainEvent } from "../db/events-repo";
import { listOrdersByUser, toDomainOrder } from "../db/orders-repo";
import type { EventRow, OrderRow } from "../db/schema";
import { seatsAvailable } from "../domain/booking";
import { previewCancellation } from "../domain/cancellation";
import { buildInvoice, EARLY_BIRD_PERCENT, earlyBirdApplies, earlyBirdEndsMs } from "../domain/invoice";
import { priceTiers } from "../domain/pricing";
import type { PaymentProvider } from "../payments";
import { cancelOwnOrder, OrderError, placeOrder, quoteOrder } from "../services/orders";
import { loadHelpDocs, searchDocs } from "./docs";

/** Who is calling. null = anonymous: public tools only. */
export type Caller = {
  userId: string;
  email: string;
  name: string;
  role: string | null;
  /** what the caller's API key may do: "tickets:read", "tickets:write" */
  scopes: string[];
} | null;

export interface ToolDeps {
  db: Db;
  payments: PaymentProvider;
  now: () => number;
  /** the web app's origin, for deep links, e.g. http://localhost:3000 */
  baseURL: string;
}

export const PUBLIC_TOOLS = ["list_events", "get_event", "quote_price", "search_docs"] as const;
export const PRIVATE_TOOLS = ["book_tickets", "my_orders", "refund_order", "cancel_event"] as const;

/** The key scope each private tool needs. A read-only key gets tickets:read only. */
const SCOPE: Record<(typeof PRIVATE_TOOLS)[number], string> = {
  book_tickets: "tickets:write",
  my_orders: "tickets:read",
  refund_order: "tickets:write",
  cancel_event: "tickets:write",
};

export const UNAUTHENTICATED_MESSAGE =
  "Unauthorized (401): this tool acts on a customer's account, so it needs one. " +
  "Create an API key in TicketBay under Settings → Developers and send it as `Authorization: Bearer tb_…`, " +
  "Browsing tools (list_events, get_event, quote_price, search_docs) work without a key.";

const TZ = "Europe/Budapest";
const ymd = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const local = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short", timeZone: TZ });

/** "2026-10-07" — the event's calendar day in Budapest. */
const dayOf = (ms: number) => ymd.format(ms);
/** "2026-10-07 20:00" Budapest time */
const localTime = (ms: number) => local.format(ms);
const eur = (cents: number) => Math.round(cents) / 100;
export const orderNumber = (id: number) => `TB-${String(id).padStart(5, "0")}`;

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Customer-facing refusals become tool errors the model can read; bugs still throw. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message);
    if (e instanceof Error && e.name === "PaymentError") return fail(`Payment failed: ${e.message}`);
    throw e;
  }
}

/**
 * What one ticket costs if bought right now, early-bird included, fee not —
 * from the invoice module itself, so the listed price is the charged price.
 */
function currentTicketCents(ev: EventRow, nowMs: number): number {
  return buildInvoice(toDomainEvent(ev), 1, nowMs).ticketsCents;
}

function eventSummary(ev: EventRow, nowMs: number) {
  return {
    id: ev.id,
    name: ev.name,
    category: ev.category,
    venue: ev.venue,
    city: ev.city,
    starts_at: localTime(ev.startsAtMs),
    ticket_price_eur: eur(currentTicketCents(ev, nowMs)),
    seats_left: seatsAvailable(toDomainEvent(ev)),
    status: ev.cancelledAtMs !== null ? "cancelled" : ev.startsAtMs <= nowMs ? "past" : seatsAvailable(toDomainEvent(ev)) === 0 ? "sold_out" : "on_sale",
  };
}

function orderSummary(order: OrderRow, ev: EventRow, nowMs: number, baseURL: string) {
  const refund = order.status === "paid" ? previewCancellation(toDomainOrder(order, ev), nowMs) : null;
  return {
    order_id: order.id,
    order_number: orderNumber(order.id),
    event: { id: ev.id, name: ev.name, starts_at: localTime(ev.startsAtMs), cancelled: ev.cancelledAtMs !== null },
    tickets: order.quantity,
    total_paid_eur: eur(order.totalCents),
    status: order.status,
    ...(order.status === "refunded"
      ? {
          refunded_eur: eur(order.refundCents ?? 0),
          refunded_at: localTime(order.refundedAtMs ?? 0),
          ...(order.seatsReleased === false && {
            note: "Cancelled after the event started: by TicketBay's refund policy nothing is paid back and the seats stayed with the customer. This is expected, not an error.",
          }),
        }
      : {
          refund_if_cancelled_now_eur: eur(refund!.netCents),
          // How the refund is built, so no one has to reverse-engineer it:
          // tickets part − refund fee = refund; the service fee is never refunded.
          refund_breakdown: refund!.windowOpen
            ? {
                tickets_paid_eur: eur(order.ticketsCents),
                service_fee_paid_eur: eur(order.feeCents),
                refund_fee_eur: eur(refund!.feeCents),
                refund_eur: eur(refund!.netCents),
                rule: "refund = tickets paid − refund fee; the service fee is not refundable",
              }
            : {
                tickets_paid_eur: eur(order.ticketsCents),
                service_fee_paid_eur: eur(order.feeCents),
                refund_eur: 0,
                rule: "the event has started: nothing is refunded and the seats stay with the customer",
              },
          refund_window_open: refund!.windowOpen,
        }),
    url: new URL(`/orders/${order.id}`, baseURL).toString(),
  };
}

/** "group 5% + early-bird 10% + code WELCOME10 10%" */
function discountParts(group: number, earlyBird: number, code: { code: string; percent: number } | null): string {
  return [group && `group ${group}%`, earlyBird && `early-bird ${earlyBird}%`, code && `code ${code.code} ${code.percent}%`].filter(Boolean).join(" + ");
}

const orderIdInput = z
  .union([z.number().int().positive(), z.string().regex(/^(TB-)?\d+$/i)])
  .describe('The order: its number as shown to the customer ("TB-00144") or the numeric id (144).');

function parseOrderId(v: number | string): number {
  return typeof v === "number" ? v : Number(v.replace(/^TB-/i, ""));
}

/**
 * One MCP server instance for one caller. The remote endpoint builds a fresh
 * one per request (the 2026-07-28 protocol is stateless), so `caller` is
 * fixed for the instance's whole life.
 */
export function createTicketBayServer(deps: ToolDeps, caller: Caller, opts: { includePrivate: boolean }): McpServer {
  const server = new McpServer(
    { name: "ticketbay", version: "2.0.0" },
    {
      instructions:
        "TicketBay sells tickets for concerts, festivals, conferences and comedy nights in Hungary. Prices are in EUR, VAT included. " +
        "Browse with list_events → get_event → quote_price. " +
        (opts.includePrivate
          ? "book_tickets charges the customer's card; always quote first and get the customer's explicit yes. " +
            "refund_order cannot be undone; say the refund amount from my_orders before calling it."
          : "This local server only browses. Booking needs TicketBay's remote MCP server with an API key.") +
        " For questions about refunds, discounts, fees or API keys, call search_docs and answer from the docs.",
    },
  );
  const { db, now, baseURL } = deps;

  // ---- Public tools: anyone may read the catalogue. -------------------------

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "Search upcoming TicketBay events. Filter by date range (Budapest calendar days), category, city and the price of ONE ticket bought today " +
        "(early-bird included, 3% service fee not included). Returns today's date so you can resolve 'next month' or 'this weekend'. " +
        "Past and cancelled events are left out. Sold-out events are included only when include_sold_out is true.",
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, inclusive, YYYY-MM-DD. Default: today."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day, inclusive, YYYY-MM-DD."),
        category: z.enum(["concert", "festival", "conference", "comedy"]).optional(),
        city: z.string().optional().describe("City name, e.g. Budapest. Case-insensitive."),
        max_price_eur: z.number().positive().optional().describe("Only events where one ticket costs at most this, in EUR."),
        include_sold_out: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const nowMs = now();
      const today = dayOf(nowMs);
      const rows = (await listEvents(db))
        .filter((ev) => ev.cancelledAtMs === null && ev.startsAtMs > nowMs)
        .filter((ev) => dayOf(ev.startsAtMs) >= (args.from ?? today) && (!args.to || dayOf(ev.startsAtMs) <= args.to))
        .filter((ev) => !args.category || ev.category === args.category)
        .filter((ev) => !args.city || ev.city.toLowerCase() === args.city.trim().toLowerCase())
        .filter((ev) => args.max_price_eur === undefined || currentTicketCents(ev, nowMs) <= Math.round(args.max_price_eur * 100))
        .filter((ev) => args.include_sold_out || seatsAvailable(toDomainEvent(ev)) > 0)
        .map((ev) => eventSummary(ev, nowMs));
      return json({ today, timezone: TZ, count: rows.length, events: rows });
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Get event details",
      description:
        "Everything about one event: description, date, venue, seats left, the group-discount price tiers (per-ticket price by quantity), " +
        "and whether the early-bird discount applies and until when. Use the id from list_events.",
      inputSchema: z.object({ event_id: z.string().describe('Event id from list_events, e.g. "midnight-arcade-neon-tour".') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ event_id }) => {
      const ev = await getEvent(db, event_id);
      if (!ev) return fail(`No event with id "${event_id}". Use list_events to find one.`);
      const nowMs = now();
      const eb = earlyBirdApplies({ startMs: ev.startsAtMs }, nowMs);
      return json({
        ...eventSummary(ev, nowMs),
        description: ev.description,
        total_seats: ev.totalSeats,
        base_price_eur: eur(ev.priceCents),
        price_tiers: priceTiers(ev.priceCents).map((t) => ({
          tickets: t.maxQty === null ? `${t.minQty}+` : `${t.minQty}-${t.maxQty}`,
          group_discount_percent: t.percent,
          per_ticket_eur_before_early_bird: eur(t.unitCents),
        })),
        early_bird: eb
          ? { applies: true, percent_off: EARLY_BIRD_PERCENT, ends_at: localTime(earlyBirdEndsMs({ startMs: ev.startsAtMs })) }
          : { applies: false, note: `Early-bird (${EARLY_BIRD_PERCENT}% off) ends 30 days before the event.` },
        service_fee: "3% of the ticket amount after discounts, at least €1.00 and at most €20.00, added at checkout, not refundable",
        url: new URL(`/events/${ev.id}`, baseURL).toString(),
      });
    },
  );

  server.registerTool(
    "quote_price",
    {
      title: "Quote a price",
      description:
        "Exact price for N tickets to one event, bought right now, with an optional discount code: every line of the invoice " +
        "(subtotal, group / early-bird / code discounts, service fee, total, VAT inside the total). Books nothing and charges nothing. " +
        "An invalid or expired code is reported as an error — quote again without it.",
      inputSchema: z.object({
        event_id: z.string(),
        quantity: z.number().int().min(1).max(50).describe("Number of tickets, 1-50."),
        discount_code: z.string().optional().describe("e.g. WELCOME10. Case-insensitive."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ event_id, quantity, discount_code }) =>
      run(async () => {
        const { invoice: inv, code } = await quoteOrder({ db, nowMs: now() }, event_id, quantity, discount_code ?? "");
        return json({
          event_id,
          quantity,
          line_items: [
            { label: `${quantity} × ticket`, eur: eur(inv.subtotalCents) },
            ...(inv.discountPercent
              ? [{ label: `Discount ${inv.discountPercent}% (${discountParts(inv.groupPercent, inv.earlyBirdPercent, code)}${inv.groupPercent + inv.earlyBirdPercent + inv.codePercent > inv.discountPercent ? `, capped at ${inv.discountPercent}%` : ""})`, eur: -eur(inv.discountCents) }]
              : []),
            { label: "Tickets", eur: eur(inv.ticketsCents) },
            { label: "Service fee (3%)", eur: eur(inv.feeCents) },
            { label: "Total", eur: eur(inv.totalCents) },
          ],
          total_eur: eur(inv.totalCents),
          vat_included_eur: eur(inv.vatCents),
        });
      }),
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the help docs",
      description:
        "Search TicketBay's help pages — refund policy, early-bird and discounts, fees, API keys — and return the best-matching sections, " +
        "quoted verbatim with their source file. Use it for any question about rules or policy (e.g. 'how do refunds work for early-bird tickets?') " +
        "and answer from what it returns, not from general knowledge.",
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe("The question or keywords, e.g. 'refund early-bird tickets'."),
        limit: z.number().int().min(1).max(5).default(3),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = searchDocs(loadHelpDocs(), query, limit);
      if (hits.length === 0) return json({ query, results: [], note: "No help section matches. Try other words, or say the docs do not cover it." });
      return json({
        query,
        results: hits.map((h) => ({ page: h.page, section: h.heading, source: h.file, text: h.text })),
      });
    },
  );

  if (!opts.includePrivate) return server;

  // ---- Private tools: act for one customer. ---------------------------------

  /** The caller if their key allows this tool, else a 401/403-style tool error the agent can read. */
  const who = (tool: (typeof PRIVATE_TOOLS)[number]): NonNullable<Caller> | CallToolResult => {
    if (!caller) return fail(UNAUTHENTICATED_MESSAGE);
    if (!caller.scopes.includes(SCOPE[tool])) {
      return fail(
        `Forbidden (403): ${tool} needs a key with the ${SCOPE[tool]} scope, and this key is ` +
          `${caller.scopes.includes("tickets:read") ? "read-only" : "not allowed to use it"}. ` +
          "Create a read & write key under Settings → Developers if the customer wants the agent to do this.",
      );
    }
    return caller;
  };
  const isResult = (x: unknown): x is CallToolResult => typeof x === "object" && x !== null && "content" in x;

  server.registerTool(
    "book_tickets",
    {
      title: "Book tickets",
      description:
        "Book and PAY for tickets as the signed-in customer: charges their card on file and returns the order. " +
        "Call quote_price first, show the customer the total, and only book after they say yes. " +
        "Pass the same idempotency_key only to retry after a timeout or lost reply (you get the same order back, never a second charge); " +
        "after a booking error, use a NEW key. Requires a read & write API key.",
      inputSchema: z.object({
        event_id: z.string(),
        quantity: z.number().int().min(1).max(50),
        discount_code: z.string().optional(),
        name_on_tickets: z.string().optional().describe("Defaults to the account holder's name."),
        idempotency_key: z.string().max(100).optional().describe("Any unique string for this purchase; reuse it only to retry the same purchase."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const c = who("book_tickets");
      if (isResult(c)) return c;
      return run(async () => {
        const nowMs = now();
        const { order, replayed } = await placeOrder(
          { db, payments: deps.payments, nowMs },
          {
            eventId: args.event_id,
            quantity: args.quantity,
            code: args.discount_code ?? "",
            email: c.email,
            name: args.name_on_tickets?.trim() || c.name,
            userId: c.userId,
            // Namespaced per user: one customer's key can never replay another's order.
            idempotencyKey: `mcp:${c.userId}:${args.idempotency_key ?? randomUUID()}`,
          },
        );
        const ev = (await getEvent(db, order.eventId))!;
        return json({ booked: true, replayed, ...orderSummary(order, ev, nowMs, baseURL) });
      });
    },
  );

  server.registerTool(
    "my_orders",
    {
      title: "My orders",
      description:
        "The signed-in customer's orders, newest first: event, tickets, amount paid, status, and — for paid orders — how much a refund would return right now. " +
        "Only ever shows the caller's own orders. Requires an API key (read-only is enough).",
      inputSchema: z.object({ status: z.enum(["paid", "refunded", "all"]).default("all") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status }) => {
      const c = who("my_orders");
      if (isResult(c)) return c;
      const nowMs = now();
      const rows = (await listOrdersByUser(db, c.userId)).filter(({ order }) => status === "all" || order.status === status);
      return json({ customer: c.email, count: rows.length, orders: rows.map(({ order, event }) => orderSummary(order, event, nowMs, baseURL)) });
    },
  );

  server.registerTool(
    "refund_order",
    {
      title: "Refund an order",
      description:
        "Cancel one of the customer's own orders and refund it NOW, by TicketBay's refund rules (refund fee kept; nothing back once the event has started). " +
        "Cannot be undone. Tell the customer the refund amount from my_orders and get an explicit yes first. " +
        "Returns the refund and a link to the order page. Requires a read & write API key.",
      inputSchema: z.object({ order_id: orderIdInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ order_id }) => {
      const c = who("refund_order");
      if (isResult(c)) return c;
      return run(async () => {
        const id = parseOrderId(order_id);
        const nowMs = now();
        const r = await cancelOwnOrder({ db, payments: deps.payments, nowMs }, c.userId, id);
        const ev = (await getEvent(db, r.order.eventId))!;
        return json({
          refunded: true,
          refunded_eur: eur(r.refundCents),
          refund_fee_kept_eur: eur(r.refundFeeCents),
          seats_released: r.seatsReleased,
          ...orderSummary(r.order, ev, nowMs, baseURL),
        });
      });
    },
  );

  server.registerTool(
    "cancel_event",
    {
      title: "Cancel an event (admin)",
      description:
        "Admins only. Prepares cancelling a whole event — which refunds every ticket holder — but does NOT cancel it: " +
        "it returns a link to the admin dashboard, where a human reviews the impact and confirms. Give the link to the user.",
      inputSchema: z.object({ event_id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ event_id }) => {
      const c = who("cancel_event");
      if (isResult(c)) return c;
      if (c.role !== "admin") return fail("Forbidden (403): only TicketBay admins can cancel events.");
      const ev = await getEvent(db, event_id);
      if (!ev) return fail(`No event with id "${event_id}".`);
      if (ev.cancelledAtMs !== null) return fail(`${ev.name} is already cancelled.`);
      if (ev.startsAtMs <= now()) return fail(`${ev.name} has already started — a past event cannot be cancelled.`);
      const impact = await cancelImpact(db, ev.id);
      const url = new URL(`/admin/events/${encodeURIComponent(ev.id)}/cancel`, baseURL);
      url.searchParams.set("via", "mcp");
      return json({
        cancelled: false,
        action_required: "A human must confirm this in the dashboard. Nothing has changed yet.",
        event: { id: ev.id, name: ev.name, starts_at: localTime(ev.startsAtMs) },
        impact_if_confirmed: {
          paid_orders_refunded: impact.orders,
          tickets_refunded: impact.tickets,
          refund_total_eur: eur(impact.refundCents),
        },
        confirm_url: url.toString(),
      });
    },
  );

  return server;
}
