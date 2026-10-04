// TicketBay's public REST API, version 1 — served by the route handlers in
// app/api/v1. Thin, like the MCP tools: a handler validates its input, calls
// src/services, and shapes the answer. Every rule (prices, seats, refunds,
// idempotency) lives where the web app and the MCP server already use it.
//
// The contract every endpoint keeps:
//   - money is integer cents, instants are ISO 8601 strings;
//   - a client error is a 4xx with a JSON {"error": "..."} body a person can read;
//   - nothing internal (a stack, a SQL error) ever reaches a response — an
//     unexpected failure is logged and answered with a fixed 500.
import * as z from "zod";
import { orderNumber } from "../../lib/format";
import { eventStatus } from "../../lib/status";
import type { Auth } from "../auth/auth";
import type { Db } from "../db/client";
import { getEvent, listEvents, toDomainEvent } from "../db/events-repo";
import type { EventRow, OrderRow } from "../db/schema";
import { seatsAvailable } from "../domain/booking";
import { earlyBirdEndsMs, type Invoice } from "../domain/invoice";
import { resolveCaller } from "../mcp/caller";
import { PaymentError, type PaymentProvider } from "../payments";
import { cancelOwnOrder, OrderError, placeOrder, quoteOrder } from "../services/orders";

export interface ApiDeps {
  db: Db;
  payments: PaymentProvider;
  /** lazy: the public endpoints never need it */
  auth: () => Auth;
  /** "now" for this request — the wall clock, or the test clock (lib/clock.ts) */
  now: (request: Request) => number;
}

/** A refusal with its HTTP status. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

// ---- Input ------------------------------------------------------------------

/** Event ids are slugs: "midnight-arcade-neon-tour". */
const EventId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "must be an event id from GET /api/v1/events");

const CartBody = z.object({
  eventId: EventId,
  tickets: z.number().int().min(1).max(50),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{0,40}$/, "must be a discount code like WELCOME10")
    .optional(),
});

/** Same limit the MCP server puts on its idempotency_key. */
const IdempotencyKey = z.string().trim().min(1).max(100);

/** Order ids are positive Postgres INTEGERs, written in decimal. */
const OrderIdParam = z.string().regex(/^[1-9]\d{0,9}$/);

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    throw new ApiError(400, 'The body must be JSON, e.g. {"eventId": "midnight-arcade-neon-tour", "tickets": 2}.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ApiError(400, `${issue.path.join(".") || "body"}: ${issue.message}`);
  }
  return parsed.data;
}

// ---- Auth -------------------------------------------------------------------

const API_REALM = 'Bearer realm="TicketBay API"';

/** The account behind the request's API key, if the key may write. */
async function writer(deps: ApiDeps, request: Request): Promise<{ userId: string; email: string; name: string }> {
  const resolved = await resolveCaller({ auth: deps.auth(), db: deps.db }, request);
  if (!resolved.ok) throw new ApiError(401, resolved.error, { "WWW-Authenticate": API_REALM });
  const caller = resolved.caller;
  if (!caller) {
    throw new ApiError(401, "This endpoint needs an API key: send `Authorization: Bearer tb_…` (create one under Settings → Developers).", {
      "WWW-Authenticate": API_REALM,
    });
  }
  if (!caller.scopes.includes("tickets:write")) {
    throw new ApiError(403, "This API key is read-only. Create a read & write key under Settings → Developers.");
  }
  return caller;
}

// ---- Output -----------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

function eventJson(ev: EventRow, nowMs: number) {
  return {
    id: ev.id,
    name: ev.name,
    category: ev.category,
    venue: ev.venue,
    city: ev.city,
    startsAt: iso(ev.startsAtMs),
    priceCents: ev.priceCents,
    totalSeats: ev.totalSeats,
    seatsLeft: seatsAvailable(toDomainEvent(ev)),
    status: eventStatus(ev, nowMs),
    /** the last instant a booking still gets the early-bird price */
    earlyBirdEndsAt: iso(earlyBirdEndsMs({ startMs: ev.startsAtMs })),
  };
}

function priceJson(inv: Invoice) {
  return {
    subtotalCents: inv.subtotalCents,
    groupPercent: inv.groupPercent,
    earlyBirdPercent: inv.earlyBirdPercent,
    codePercent: inv.codePercent,
    discountPercent: inv.discountPercent,
    discountCents: inv.discountCents,
    ticketsCents: inv.ticketsCents,
    feeCents: inv.feeCents,
    totalCents: inv.totalCents,
    vatCents: inv.vatCents,
  };
}

function orderJson(o: OrderRow) {
  return {
    id: o.id,
    orderNumber: orderNumber(o.id),
    eventId: o.eventId,
    tickets: o.quantity,
    status: o.status,
    discountCode: o.discountCode,
    price: priceJson(o),
    createdAt: iso(o.createdAtMs),
    refundedAt: o.refundedAtMs === null ? null : iso(o.refundedAtMs),
    refundCents: o.refundCents,
  };
}

// ---- Errors -----------------------------------------------------------------

/** OrderError carries only its message; these two mean "no such thing (for you)". */
const NOT_FOUND = new Set(["Event not found.", "Order not found."]);

export const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: message }, { status, headers });

/**
 * One log line for an unexpected failure: the request and the root cause (a
 * driver error, not drizzle's wrapper that repeats the whole query).
 */
function logFailure(request: Request, e: unknown) {
  const cause = (e as { cause?: unknown })?.cause ?? e;
  const why = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error(`[api/v1] 500 ${request.method} ${new URL(request.url).pathname}: ${why.replace(/\s+/g, " ")}`);
}

/** Runs a handler and turns every refusal into its 4xx; anything else is a logged 500. */
async function handle(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ApiError) return error(e.status, e.message, e.headers);
    if (e instanceof OrderError) return error(NOT_FOUND.has(e.message) ? 404 : 422, e.message);
    if (e instanceof PaymentError) return error(402, `Payment failed: ${e.message}`);
    logFailure(request, e);
    return error(500, "Something went wrong on our side. Try again later.");
  }
}

// ---- Endpoints --------------------------------------------------------------

/** GET /api/v1/events */
export function listEventsEndpoint(deps: ApiDeps, request: Request): Promise<Response> {
  return handle(request, async () => {
    const nowMs = deps.now(request);
    return Response.json({ events: (await listEvents(deps.db)).map((ev) => eventJson(ev, nowMs)) });
  });
}

/** GET /api/v1/events/{id} */
export function getEventEndpoint(deps: ApiDeps, request: Request, id: string): Promise<Response> {
  return handle(request, async () => {
    const ev = EventId.safeParse(id).success ? await getEvent(deps.db, id) : undefined;
    if (!ev) throw new ApiError(404, "Event not found.");
    return Response.json({ ...eventJson(ev, deps.now(request)), description: ev.description });
  });
}

/** POST /api/v1/quote — prices a cart; books and charges nothing. */
export function quoteEndpoint(deps: ApiDeps, request: Request): Promise<Response> {
  return handle(request, async () => {
    const cart = await readBody(request, CartBody);
    const { invoice, code } = await quoteOrder({ db: deps.db, nowMs: deps.now(request) }, cart.eventId, cart.tickets, cart.code ?? "");
    return Response.json({ eventId: cart.eventId, tickets: cart.tickets, code, price: priceJson(invoice) });
  });
}

/** POST /api/v1/orders — books and pays. 201 for a new order, 200 for a replay of the same Idempotency-Key. */
export function placeOrderEndpoint(deps: ApiDeps, request: Request): Promise<Response> {
  return handle(request, async () => {
    const caller = await writer(deps, request);
    const key = IdempotencyKey.safeParse(request.headers.get("idempotency-key") ?? "");
    if (!key.success) {
      throw new ApiError(400, "Send an Idempotency-Key header (1-100 characters, unique per purchase; reuse it only to retry the same purchase).");
    }
    const cart = await readBody(request, CartBody);
    const { order, replayed } = await placeOrder(
      { db: deps.db, payments: deps.payments, nowMs: deps.now(request) },
      {
        eventId: cart.eventId,
        quantity: cart.tickets,
        code: cart.code ?? "",
        email: caller.email,
        name: caller.name,
        userId: caller.userId,
        // Namespaced per user, like the MCP server's: one customer's key can never replay another's order.
        idempotencyKey: `api:${caller.userId}:${key.data}`,
      },
    );
    return Response.json({ replayed, order: orderJson(order) }, { status: replayed ? 200 : 201 });
  });
}

/** POST /api/v1/orders/{id}/cancel — cancels one of the caller's own orders and refunds it by the refund rules. */
export function cancelOrderEndpoint(deps: ApiDeps, request: Request, id: string): Promise<Response> {
  return handle(request, async () => {
    const caller = await writer(deps, request);
    // An id that cannot name an order is simply not found — the same answer as someone else's order.
    if (!OrderIdParam.safeParse(id).success) throw new ApiError(404, "Order not found.");
    const r = await cancelOwnOrder({ db: deps.db, payments: deps.payments, nowMs: deps.now(request) }, caller.userId, Number(id));
    return Response.json({
      refund: { refundCents: r.refundCents, refundFeeCents: r.refundFeeCents, seatsReleased: r.seatsReleased },
      order: orderJson(r.order),
    });
  });
}
