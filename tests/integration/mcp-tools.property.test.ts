// Property tests for the MCP tools' money shaping and filtering
// (src/mcp/tools.ts), against a real Postgres.
//
// Invariants, in English:
//  1. list_events returns exactly the events that are on sale, not cancelled,
//     start after now, fall on a Budapest calendar day inside [from, to]
//     (from defaults to today in Budapest), match the category, have a seat
//     left, and whose one-ticket price today is at most max_price_eur.
//  2. The "price of one ticket today" list_events shows is exactly what
//     quote_price says one ticket costs today (the Tickets line: early-bird
//     included, fee not) — a customer is never shown one price and charged another.
//  3. quote_price's line items reconcile: ticket subtotal + discount line = Tickets,
//     Tickets + service fee = Total, Total = total_eur; VAT sits inside the total.
//     The discount label's parts add up to the headline discount percent.
//  4. quote_price's total is exactly what book_tickets then charges at the same instant.
//  5. my_orders' refund_breakdown reconciles with what was paid: tickets part +
//     service fee = total paid; refund ≤ tickets paid; refund = tickets paid −
//     refund fee (the rule the breakdown itself states); refund_eur equals
//     refund_if_cancelled_now_eur; refund_order at the same instant pays exactly that.
//  6. Every spelling of an order id ("TB-00144", "tb-144", "144", 144) names the
//     same order, and any schema-valid id that is not the caller's own order is
//     a readable "Order not found." tool error — never a thrown exception.
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createEvent } from "../../src/db/events-repo";
import { discountCodes, events, orders, user } from "../../src/db/schema";
import { createTicketBayServer, orderNumber, type Caller } from "../../src/mcp/tools";
import { createFakeStripe } from "../../src/payments";
import { useTestDatabase } from "./database";

const t = useTestDatabase();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cents = (eur: number) => Math.round(eur * 100);
const CATEGORIES = ["concert", "festival", "conference", "comedy"] as const;

// ---- An independent Budapest calendar (EU DST rule, not Intl). ------------------
/** 01:00 UTC on the last Sunday of the month: when EU clocks change. */
function lastSundayOneUtc(year: number, month0: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0));
  return Date.UTC(year, month0, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
}
/** "YYYY-MM-DD" of instant `ms` on a Budapest wall clock (CET +1 / CEST +2). */
function budapestDay(ms: number): string {
  const y = new Date(ms).getUTCFullYear();
  const summer = ms >= lastSundayOneUtc(y, 2) && ms < lastSundayOneUtc(y, 9);
  return new Date(ms + (summer ? 2 : 1) * HOUR).toISOString().slice(0, 10);
}
function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

// ---- Calling the tools the way the SDK does: schema-parse, then the handler. ----
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
function tools(nowMs: number, caller: Caller = null, payments = createFakeStripe("sk_test_property")) {
  const server = createTicketBayServer({ db: t.db, payments, now: () => nowMs, baseURL: "http://localhost:3000" }, caller, {
    includePrivate: true,
  });
  const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema: { parse(x: unknown): unknown }; handler: (a: unknown, e: unknown) => Promise<ToolResult> }> })._registeredTools;
  return async (name: string, raw: unknown): Promise<ToolResult> => {
    const tool = registered[name];
    return tool.handler(tool.inputSchema.parse(raw), {});
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: ToolResult): any => {
  if (r.isError) throw new Error(`tool error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

async function reset() {
  await t.db.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
}

// ---- Generators: instants that sit on the edges that matter. --------------------
/** Instants in 2026-2028, biased to DST switches and Budapest midnights. */
const instant = fc.oneof(
  fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 11, 31) }),
  fc
    .tuple(fc.constantFrom(2026, 2027, 2028), fc.constantFrom(2, 9), fc.integer({ min: -3 * HOUR, max: 3 * HOUR }))
    .map(([y, m, d]) => lastSundayOneUtc(y, m) + d),
  fc
    .tuple(fc.integer({ min: Date.UTC(2026, 0, 1) / DAY, max: Date.UTC(2028, 11, 31) / DAY }), fc.integer({ min: 21 * 60, max: 24 * 60 + 60 }))
    .map(([d, m]) => d * DAY + m * MIN),
);
/** Prices in cents: 1 cent, odd cents, x5 cents, large amounts. */
const priceCents = fc.oneof(
  fc.integer({ min: 1, max: 20 }),
  fc.integer({ min: 1, max: 2_000 }).map((n) => n * 10 + 5),
  fc.integer({ min: 1, max: 2_000_000 }),
);
/** An event start relative to now: past, now, just over/under the 30-day early-bird edge, far. */
const startOffset = fc.oneof(
  fc.integer({ min: -3 * DAY, max: 60 * DAY }),
  fc.integer({ min: -2, max: 2 }).map((d) => 30 * DAY + d),
  fc.integer({ min: -2, max: 2 }),
  fc.tuple(fc.integer({ min: 0, max: 45 }), fc.integer({ min: -MIN, max: MIN })).map(([d, j]) => d * DAY + j),
);

const eventSpec = fc.record({
  start: startOffset,
  priceCents,
  category: fc.constantFrom(...CATEGORIES),
  totalSeats: fc.integer({ min: 1, max: 5 }),
  soldOut: fc.boolean(),
  cancelled: fc.boolean(),
});

async function seedEvents(nowMs: number, specs: fc.RecordValue<typeof eventSpec>[] | readonly { start: number; priceCents: number; category: (typeof CATEGORIES)[number]; totalSeats: number; soldOut: boolean; cancelled: boolean }[]) {
  const rows = [];
  for (const [i, s] of specs.entries()) {
    rows.push(
      await createEvent(t.db, {
        id: `ev-${i}`,
        name: `Event ${i}`,
        category: s.category,
        venue: "Arena",
        city: "Budapest",
        startsAtMs: nowMs + s.start,
        totalSeats: s.totalSeats,
        seatsSold: s.soldOut ? s.totalSeats : 0,
        priceCents: s.priceCents,
        createdAtMs: nowMs - 90 * DAY,
        cancelledAtMs: s.cancelled ? nowMs - HOUR : null,
      }),
    );
  }
  return rows;
}

const RUNS = { numRuns: 40 };
const TIMEOUT = 240_000;

describe("list_events", () => {
  it(
    "returns exactly the on-sale events on the requested Budapest days, category and budget",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          instant,
          fc.array(eventSpec, { minLength: 1, maxLength: 6 }),
          fc.record({
            fromShift: fc.option(fc.integer({ min: -2, max: 40 }), { nil: undefined }),
            span: fc.option(fc.integer({ min: -1, max: 40 }), { nil: undefined }),
            category: fc.option(fc.constantFrom(...CATEGORIES), { nil: undefined }),
            budget: fc.option(
              fc.oneof(
                fc.integer({ min: 1, max: 2_000_000 }).map((c) => c / 100),
                fc.double({ min: 0.001, max: 25_000, noNaN: true, noDefaultInfinity: true }),
              ),
              { nil: undefined },
            ),
            includeSoldOut: fc.boolean(),
            /** budget = exactly one event's real one-ticket price: the boundary the filter must include */
            budgetAtEvent: fc.option(fc.nat(), { nil: undefined }),
          }),
          async (nowMs, specs, f) => {
            await reset();
            const rows = await seedEvents(nowMs, specs);
            const call = tools(nowMs);
            const today = budapestDay(nowMs);
            const from = f.fromShift === undefined ? undefined : shiftDay(today, f.fromShift);
            const to = f.span === undefined ? undefined : shiftDay(from ?? today, f.span);

            // What one ticket really costs today: quote_price's Tickets line. A
            // sold-out event cannot be quoted; for those, the price list_events
            // itself shows (unfiltered) stands in.
            const oneTicket = new Map<string, number>();
            const shown = body(await call("list_events", { from: "2000-01-01", include_sold_out: true })).events as { id: string; ticket_price_eur: number }[];
            for (const r of rows) {
              if (r.cancelledAtMs !== null || r.startsAtMs <= nowMs) continue;
              if (r.seatsSold >= r.totalSeats) {
                oneTicket.set(r.id, cents(shown.find((e) => e.id === r.id)!.ticket_price_eur));
                continue;
              }
              const q = body(await call("quote_price", { event_id: r.id, quantity: 1 }));
              oneTicket.set(r.id, cents(q.line_items.find((l: { label: string }) => l.label === "Tickets").eur));
            }

            const priced = [...oneTicket.values()];
            const budget = f.budgetAtEvent !== undefined && priced.length > 0 ? priced[f.budgetAtEvent % priced.length] / 100 : f.budget;
            if (budget !== undefined && !(budget > 0)) return; // the schema demands a positive budget

            const expected = rows
              .filter((r) => r.cancelledAtMs === null && r.startsAtMs > nowMs)
              .filter((r) => budapestDay(r.startsAtMs) >= (from ?? today) && (to === undefined || budapestDay(r.startsAtMs) <= to))
              .filter((r) => f.category === undefined || r.category === f.category)
              .filter((r) => f.includeSoldOut || r.seatsSold < r.totalSeats)
              .filter((r) => budget === undefined || oneTicket.get(r.id)! / 100 <= budget)
              .map((r) => r.id)
              .sort();

            const res = body(
              await call("list_events", { from, to, category: f.category, max_price_eur: budget, include_sold_out: f.includeSoldOut }),
            );
            expect(res.today).toBe(today);
            expect(res.events.map((e: { id: string }) => e.id).sort()).toEqual(expected);
            expect(res.count).toBe(expected.length);
          },
        ),
        { numRuns: 150 },
      );
    },
    TIMEOUT,
  );

  it(
    "shows the same one-ticket price that quote_price charges today (early-bird included, fee not)",
    async () => {
      await fc.assert(
        fc.asyncProperty(instant, priceCents, startOffset.filter((s) => s > 0), async (nowMs, price, start) => {
          await reset();
          await seedEvents(nowMs, [{ start, priceCents: price, category: "concert", totalSeats: 5, soldOut: false, cancelled: false }]);
          const call = tools(nowMs);
          const listed = body(await call("list_events", { include_sold_out: true, from: "2000-01-01" })).events[0];
          const q = body(await call("quote_price", { event_id: "ev-0", quantity: 1 }));
          const tickets = q.line_items.find((l: { label: string }) => l.label === "Tickets").eur;
          expect(cents(listed.ticket_price_eur)).toBe(cents(tickets));
          expect(cents(listed.ticket_price_eur)).toBeLessThanOrEqual(price);
          expect(cents(listed.ticket_price_eur)).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 60 },
      );
    },
    TIMEOUT,
  );
});

describe("quote_price", () => {
  const quoteInput = fc.record({
    nowMs: instant,
    start: startOffset.filter((s) => s > 0),
    priceCents,
    quantity: fc.oneof(fc.constantFrom(1, 4, 5, 9, 10, 50), fc.integer({ min: 1, max: 50 })),
    codePercent: fc.option(fc.oneof(fc.constantFrom(1, 50, 99, 100), fc.integer({ min: 1, max: 100 })), { nil: undefined }),
  });

  async function seedQuote(q: fc.RecordValue<typeof quoteInput>) {
    await reset();
    await seedEvents(q.nowMs, [{ start: q.start, priceCents: q.priceCents, category: "concert", totalSeats: 60, soldOut: false, cancelled: false }]);
    if (q.codePercent !== undefined) await t.db.insert(discountCodes).values({ code: "PROP", percent: q.codePercent, createdAtMs: q.nowMs - DAY });
  }

  it(
    "line items add up: subtotal + discount = Tickets, Tickets + fee = Total = total_eur, VAT inside",
    async () => {
      await fc.assert(
        fc.asyncProperty(quoteInput, async (q) => {
          await seedQuote(q);
          const res = body(await tools(q.nowMs)("quote_price", { event_id: "ev-0", quantity: q.quantity, discount_code: q.codePercent ? "prop" : undefined }));
          const items: { label: string; eur: number }[] = res.line_items;
          const byLabel = (l: string) => cents(items.find((i) => i.label === l)!.eur);
          const subtotal = cents(items[0].eur);
          const discount = items.filter((i) => i.label.startsWith("Discount")).reduce((s, i) => s + cents(i.eur), 0);
          const ticketsLine = byLabel("Tickets");
          const fee = byLabel("Service fee (3%)");
          const total = byLabel("Total");

          expect(subtotal).toBe(q.priceCents * q.quantity);
          expect(discount).toBeLessThanOrEqual(0);
          expect(subtotal + discount).toBe(ticketsLine);
          expect(ticketsLine).toBeGreaterThanOrEqual(0);
          expect(fee).toBeGreaterThan(0);
          expect(ticketsLine + fee).toBe(total);
          expect(cents(res.total_eur)).toBe(total);
          expect(cents(res.vat_included_eur)).toBeGreaterThanOrEqual(0);
          expect(cents(res.vat_included_eur)).toBeLessThan(total);
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "the discount label's parts add up to the headline discount percent",
    async () => {
      await fc.assert(
        fc.asyncProperty(quoteInput, async (q) => {
          await seedQuote(q);
          const res = body(await tools(q.nowMs)("quote_price", { event_id: "ev-0", quantity: q.quantity, discount_code: q.codePercent ? "prop" : undefined }));
          const line = (res.line_items as { label: string }[]).find((i) => i.label.startsWith("Discount"));
          if (!line) return;
          const m = /^Discount (\d+)% \((.*)\)$/.exec(line.label)!;
          const parts = [...m[2].matchAll(/(\d+)%/g)].reduce((s, p) => s + Number(p[1]), 0);
          expect(parts).toBe(Number(m[1]));
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "the quoted total is exactly what book_tickets charges at the same instant",
    async () => {
      const [u] = await t.db
        .insert(user)
        .values({ id: "u-quote", name: "Quote Fan", email: "quote@example.com" })
        .onConflictDoNothing()
        .returning();
      const caller: Caller = { userId: "u-quote", email: "quote@example.com", name: "Quote Fan", role: null, via: "api-key", scopes: null };
      void u;
      await fc.assert(
        fc.asyncProperty(quoteInput, async (q) => {
          await seedQuote(q);
          const call = tools(q.nowMs, caller);
          const code = q.codePercent ? "prop" : undefined;
          const quoted = body(await call("quote_price", { event_id: "ev-0", quantity: q.quantity, discount_code: code }));
          const booked = body(await call("book_tickets", { event_id: "ev-0", quantity: q.quantity, discount_code: code }));
          expect(cents(booked.total_paid_eur)).toBe(cents(quoted.total_eur));
        }),
        { numRuns: 30 },
      );
    },
    TIMEOUT,
  );
});

describe("my_orders refund_breakdown and refund_order", () => {
  const CALLER: Caller = { userId: "u-prop", email: "prop@example.com", name: "Prop Fan", role: null, via: "api-key", scopes: null };
  const OTHER: Caller = { userId: "u-other", email: "other@example.com", name: "Other Fan", role: null, via: "api-key", scopes: null };

  async function ensureUsers() {
    for (const c of [CALLER, OTHER]) {
      await t.db.insert(user).values({ id: c!.userId, name: c!.name, email: c!.email }).onConflictDoNothing();
    }
  }

  const scenario = fc.record({
    bookAt: instant,
    start: fc.oneof(fc.integer({ min: 1, max: 60 * DAY }), fc.integer({ min: 1, max: 3 })),
    priceCents,
    quantity: fc.integer({ min: 1, max: 20 }),
    codePercent: fc.option(fc.oneof(fc.constant(100), fc.integer({ min: 1, max: 100 })), { nil: undefined }),
    /** when my_orders is read, relative to the event start: before, at, after */
    viewDelta: fc.oneof(fc.integer({ min: -2, max: 2 }), fc.integer({ min: -30 * DAY, max: 5 * DAY })),
  });

  async function book(s: fc.RecordValue<typeof scenario>, payments = createFakeStripe("sk_test_property")) {
    await reset();
    await ensureUsers();
    await seedEvents(s.bookAt, [{ start: s.start, priceCents: s.priceCents, category: "concert", totalSeats: 40, soldOut: false, cancelled: false }]);
    if (s.codePercent !== undefined) await t.db.insert(discountCodes).values({ code: "PROP", percent: s.codePercent, createdAtMs: s.bookAt - DAY });
    const booked = body(await tools(s.bookAt, CALLER, payments)("book_tickets", { event_id: "ev-0", quantity: s.quantity, discount_code: s.codePercent ? "PROP" : undefined }));
    // The view instant, clamped to after the booking.
    const viewAt = Math.max(s.bookAt, s.bookAt + s.start + s.viewDelta);
    return { booked, viewAt, startsAt: s.bookAt + s.start };
  }

  it(
    "the breakdown reconciles with what was paid and follows its own stated rule",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (s) => {
          const { viewAt, startsAt } = await book(s);
          const res = body(await tools(viewAt, CALLER)("my_orders", { status: "all" }));
          expect(res.count).toBe(1);
          const o = res.orders[0];
          const b = o.refund_breakdown;
          expect(cents(b.tickets_paid_eur) + cents(b.service_fee_paid_eur)).toBe(cents(o.total_paid_eur));
          expect(cents(b.refund_eur)).toBe(cents(o.refund_if_cancelled_now_eur));
          expect(cents(b.refund_eur)).toBeGreaterThanOrEqual(0);
          expect(cents(b.refund_eur)).toBeLessThanOrEqual(cents(b.tickets_paid_eur));
          expect(cents(b.refund_fee_eur)).toBeGreaterThanOrEqual(0);
          expect(o.refund_window_open).toBe(viewAt < startsAt);
          // "refund = tickets paid − refund fee"
          expect(cents(b.tickets_paid_eur) - cents(b.refund_fee_eur)).toBe(cents(b.refund_eur));
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "refund_order pays exactly what my_orders promised at the same instant, and never more than the tickets part",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, fc.nat(), async (s, spelling) => {
          const payments = createFakeStripe("sk_test_property");
          const { booked, viewAt } = await book(s, payments);
          const call = tools(viewAt, CALLER, payments);
          const promised = body(await call("my_orders", { status: "paid" })).orders[0];

          const id: number = booked.order_id;
          const spellings: (string | number)[] = [id, String(id), orderNumber(id), orderNumber(id).toLowerCase(), `TB-${id}`, `000${id}`];
          const r = body(await call("refund_order", { order_id: spellings[spelling % spellings.length] }));

          expect(r.order_id).toBe(id);
          expect(cents(r.refunded_eur)).toBe(cents(promised.refund_if_cancelled_now_eur));
          expect(cents(r.refund_fee_kept_eur)).toBe(cents(promised.refund_breakdown.refund_fee_eur));
          expect(cents(r.refunded_eur)).toBeLessThanOrEqual(cents(promised.refund_breakdown.tickets_paid_eur));

          const after = body(await call("my_orders", { status: "refunded" })).orders[0];
          expect(cents(after.refunded_eur)).toBe(cents(r.refunded_eur));
          expect(after.refund_breakdown).toBeUndefined();
        }),
        { numRuns: 30 },
      );
    },
    TIMEOUT,
  );

  it(
    "any schema-valid order id that is not the caller's own is a readable 'Order not found.' — never a crash",
    async () => {
      await reset();
      await ensureUsers();
      await seedEvents(Date.UTC(2027, 0, 1), [{ start: 10 * DAY, priceCents: 5000, category: "concert", totalSeats: 40, soldOut: false, cancelled: false }]);
      const nowMs = Date.UTC(2027, 0, 1);
      const other = body(await tools(nowMs, OTHER)("book_tickets", { event_id: "ev-0", quantity: 2 }));
      const call = tools(nowMs, CALLER);

      const digits = fc.oneof(
        fc.bigInt({ min: 1n, max: 10n ** 25n }).map(String),
        fc.constantFrom("2147483647", "2147483648", "9007199254740991", "9007199254740993", "0", "00000"),
      );
      const orderId = fc.oneof(
        digits,
        digits.map((d) => `TB-${d}`),
        digits.map((d) => `tb-${d.padStart(5, "0")}`),
        fc.oneof(fc.integer({ min: 1, max: 2_147_483_647 }), fc.integer({ min: 2_147_483_648, max: Number.MAX_SAFE_INTEGER })),
        fc.constantFrom<string | number>(other.order_id, orderNumber(other.order_id)),
      );

      await fc.assert(
        fc.asyncProperty(orderId, async (id) => {
          const r = await call("refund_order", { order_id: id });
          expect(r.isError).toBe(true);
          expect(r.content[0].text).toBe("Order not found.");
        }),
        { numRuns: 150 },
      );
    },
    TIMEOUT,
  );
});
