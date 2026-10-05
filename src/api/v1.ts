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
import { listRefundsForOrder } from "../db/refunds-repo";
import type { EventRow, OrderRow, RefundRow } from "../db/schema";
import { seatsAvailable } from "../domain/booking";
import { refundsSoFar, type CancellationQuote } from "../domain/cancellation";
import { earlyBirdEndsMs, type Invoice } from "../domain/invoice";
import { resolveCaller } from "../mcp/caller";
import { PaymentError, type PaymentProvider } from "../payments";
import { cancelOwnOrder, OrderError, placeOrder, quoteOrder, quoteOwnCancel } from "../services/orders";

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

/** How many of an order's tickets to cancel; left out, every ticket still on the order. */
const CancelBody = z.object({
  tickets: z.number().int().min(1).optional(),
});

/** `?tickets=N` on the cancel quote: a whole number, at least 1. */
const TicketsParam = z.string().regex(/^[1-9]\d{0,3}$/, "must be a whole number of tickets, at least 1, e.g. ?tickets=2");

async function readBody<T>(request: Request, schema: z.ZodType<T>, { optional = false } = {}): Promise<T> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = optional && text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(
      400,
      optional ? 'The body must be JSON, e.g. {"tickets": 2}, or empty.' : 'The body must be JSON, e.g. {"eventId": "midnight-arcade-neon-tour", "tickets": 2}.',
    );
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

/** The account behind the request's API key, if the key has the scope. */
async function keyHolder(deps: ApiDeps, request: Request, scope: "tickets:read" | "tickets:write"): Promise<{ userId: string; email: string; name: string }> {
  const resolved = await resolveCaller({ auth: deps.auth(), db: deps.db }, request);
  if (!resolved.ok) throw new ApiError(401, resolved.error, { "WWW-Authenticate": API_REALM });
  const caller = resolved.caller;
  if (!caller) {
    throw new ApiError(401, "This endpoint needs an API key: send `Authorization: Bearer tb_…` (create one under Settings → Developers).", {
      "WWW-Authenticate": API_REALM,
    });
  }
  if (!caller.scopes.includes(scope)) {
    throw new ApiError(
      403,
      scope === "tickets:write"
        ? "This API key is read-only. Create a read & write key under Settings → Developers."
        : "This API key cannot read orders. Create a key under Settings → Developers.",
    );
  }
  return caller;
}

/** The account behind the request's API key, if the key may write. */
const writer = (deps: ApiDeps, request: Request) => keyHolder(deps, request, "tickets:write");

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

/** One cancellation, or a quote for one: the same fields, so a client can compare them. */
function cancellationJson(r: Pick<CancellationQuote, "tickets" | "netCents" | "feeCents" | "releasesSeats">) {
  return { tickets: r.tickets, refundCents: r.netCents, refundFeeCents: r.feeCents, seatsReleased: r.releasesSeats };
}

function refundJson(r: RefundRow) {
  return {
    ...cancellationJson({ tickets: r.tickets, netCents: r.netCents, feeCents: r.feeCents, releasesSeats: r.seatsReleased }),
    reason: r.reason,
    refundedAt: iso(r.createdAtMs),
  };
}

/** An order. `refundedAt` and `refundCents` are totals over its refunds (null before the first). */
function orderJson(o: OrderRow, refunds: RefundRow[]) {
  const soFar = refundsSoFar(refunds);
  const last = refunds.reduce<number | null>((at, r) => (at === null || r.createdAtMs > at ? r.createdAtMs : at), null);
  return {
    id: o.id,
    orderNumber: orderNumber(o.id),
    eventId: o.eventId,
    tickets: o.quantity,
    status: o.status,
    discountCode: o.discountCode,
    price: priceJson(o),
    createdAt: iso(o.createdAtMs),
    refundedAt: last === null ? null : iso(last),
    refundCents: refunds.length === 0 ? null : soFar.grossCents - soFar.feeCents,
    ticketsCancelled: soFar.ticketsCancelled,
    refunds: refunds.map(refundJson),
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
  const path = new URL(request.url).pathname;
  const shown = path.length > 80 ? `${path.slice(0, 80)}…` : path;
  console.error(`[api/v1] 500 ${request.method} ${shown}: ${why.replace(/\s+/g, " ")}`);
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
    // A replay can be of an order cancelled since: show its refunds too.
    const refunds = replayed ? await listRefundsForOrder(deps.db, order.id) : [];
    return Response.json({ replayed, order: orderJson(order, refunds) }, { status: replayed ? 200 : 201 });
  });
}

/**
 * POST /api/v1/orders/{id}/cancel — cancels some or all of the tickets on one
 * of the caller's own orders and refunds them by the refund rules. Body
 * `{"tickets": N}` with an Idempotency-Key header, or empty for every ticket
 * left (the header is optional then). A resend of the same key answers with
 * the first cancellation (`replayed: true`) and cancels nothing more.
 */
export function cancelOrderEndpoint(deps: ApiDeps, request: Request, id: string): Promise<Response> {
  return handle(request, async () => {
    const caller = await writer(deps, request);
    // An id that cannot name an order is simply not found — the same answer as someone else's order.
    if (!OrderIdParam.safeParse(id).success) throw new ApiError(404, "Order not found.");
    const body = await readBody(request, CancelBody, { optional: true });
    const sent = request.headers.get("idempotency-key");
    const key = IdempotencyKey.safeParse(sent ?? "");
    // A count means "N more tickets": resent blindly it would cancel N again, so it must come with a key.
    if (!key.success && (sent !== null || body.tickets !== undefined)) {
      throw new ApiError(400, "Send an Idempotency-Key header (1-100 characters, unique per cancellation; reuse it only to retry the same cancellation).");
    }
    const r = await cancelOwnOrder(
      { db: deps.db, payments: deps.payments, nowMs: deps.now(request) },
      caller.userId,
      Number(id),
      body.tickets,
      // Namespaced per user, like an order's: one customer's key can never replay another's cancellation.
      key.success ? `api:${caller.userId}:${key.data}` : undefined,
    );
    return Response.json({
      replayed: r.replayed,
      refund: cancellationJson({ tickets: r.tickets, netCents: r.refundCents, feeCents: r.refundFeeCents, releasesSeats: r.seatsReleased }),
      order: orderJson(r.order, r.refunds),
    });
  });
}

/**
 * GET /api/v1/orders/{id}/cancel-quote?tickets=N — what cancelling N tickets
 * (default: every ticket left) of one of the caller's orders would pay right
 * now. Changes nothing; any key that can read orders may ask.
 */
export function cancelQuoteEndpoint(deps: ApiDeps, request: Request, id: string): Promise<Response> {
  return handle(request, async () => {
    const caller = await keyHolder(deps, request, "tickets:read");
    if (!OrderIdParam.safeParse(id).success) throw new ApiError(404, "Order not found.");
    const raw = new URL(request.url).searchParams.get("tickets");
    if (raw !== null && !TicketsParam.safeParse(raw).success) {
      throw new ApiError(400, "tickets: must be a whole number of tickets, at least 1, e.g. ?tickets=2");
    }
    const q = await quoteOwnCancel({ db: deps.db, nowMs: deps.now(request) }, caller.userId, Number(id), raw === null ? undefined : Number(raw));
    return Response.json({
      orderId: q.order.id,
      ticketsLeft: q.ticketsLeft,
      refundWindowOpen: q.windowOpen,
      refund: cancellationJson(q),
    });
  });
}
