// Property tests for API-key scopes on the private MCP tools, and for the
// search_docs tool's contract, against a real Postgres.
//
// Invariants, in English:
//  1. For any set of key scopes (the real ones, near-misses like "TICKETS:WRITE",
//     "tickets:write ", "tickets:*", junk, duplicates, empty) and any private tool,
//     the tool runs iff the exact scope it needs is in the set:
//     book_tickets / refund_order / cancel_event need "tickets:write",
//     my_orders needs "tickets:read". Anonymous callers never run a private tool.
//  2. A refused call writes nothing: orders, events and the payment provider's
//     charges are exactly as before, and the refusal is a readable tool error
//     (isError), not an exception.
//  3. search_docs (public, no key) never errors for any query of 2..200 characters
//     and returns at most `limit` results (3 when no limit is given), each quoted
//     with its source file under help/.
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createEvent } from "../../src/db/events-repo";
import { discountCodes, events, orders, user } from "../../src/db/schema";
import { createTicketBayServer, PRIVATE_TOOLS, type Caller } from "../../src/mcp/tools";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { placeOrder } from "../../src/services/orders";
import { useTestDatabase } from "./database";

const t = useTestDatabase();

const NOW = Date.UTC(2027, 0, 15, 12);
const DAY = 86_400_000;
const NEEDS: Record<(typeof PRIVATE_TOOLS)[number], string> = {
  book_tickets: "tickets:write",
  my_orders: "tickets:read",
  refund_order: "tickets:write",
  cancel_event: "tickets:write",
};

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
function tools(caller: Caller, payments: PaymentProvider) {
  const server = createTicketBayServer({ db: t.db, payments, now: () => NOW, baseURL: "http://localhost:3000" }, caller, { includePrivate: true });
  const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema: { parse(x: unknown): unknown }; handler: (a: unknown, e: unknown) => Promise<ToolResult> }> })._registeredTools;
  return (name: string, raw: unknown): Promise<ToolResult> => registered[name].handler(registered[name].inputSchema.parse(raw), {});
}

const scopeWord = fc.constantFrom(
  "tickets:read",
  "tickets:write",
  "TICKETS:WRITE",
  "Tickets:Read",
  "tickets:write ",
  " tickets:read",
  "tickets:*",
  "tickets",
  "write",
  "read",
  "tickets:read tickets:write",
  "admin",
  "",
);
const scopeSet = fc.oneof(fc.array(scopeWord, { maxLength: 5 }), fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }));

async function snapshot(payments: PaymentProvider) {
  const o = await t.db.select().from(orders).orderBy(orders.id);
  const e = await t.db.select().from(events).orderBy(events.id);
  return { orders: o, events: e, charges: o.map((x) => payments.getCharge(x.paymentId)?.refundedCents ?? null) };
}

describe("private tools and key scopes", () => {
  it(
    "a tool runs iff its scope is in the key's set; a refused call writes nothing",
    async () => {
      await t.db.insert(user).values({ id: "u-admin", name: "Ada Admin", email: "ada@example.com", role: "admin" }).onConflictDoNothing();
      await fc.assert(
        fc.asyncProperty(fc.option(scopeSet, { nil: null, freq: 8 }), fc.constantFrom(...PRIVATE_TOOLS), async (scopes, tool) => {
          await t.db.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
          const payments = createFakeStripe("sk_test_property");
          await createEvent(t.db, {
            id: "ev",
            name: "Scope Night",
            category: "concert",
            venue: "Arena",
            city: "Budapest",
            startsAtMs: NOW + 10 * DAY,
            totalSeats: 100,
            seatsSold: 0,
            priceCents: 5000,
            createdAtMs: NOW - 30 * DAY,
          });
          const { order } = await placeOrder(
            { db: t.db, payments, nowMs: NOW - DAY },
            { eventId: "ev", quantity: 2, email: "ada@example.com", name: "Ada", idempotencyKey: "seed", userId: "u-admin" },
          );
          const caller: Caller = scopes === null ? null : { userId: "u-admin", email: "ada@example.com", name: "Ada Admin", role: "admin", scopes };
          const args = {
            book_tickets: { event_id: "ev", quantity: 1, idempotency_key: "scope-test" },
            my_orders: {},
            refund_order: { order_id: order.id },
            cancel_event: { event_id: "ev" },
          }[tool];

          const before = await snapshot(payments);
          const r = await tools(caller, payments)(tool, args);
          const allowed = scopes !== null && scopes.includes(NEEDS[tool]);

          expect(r.isError === true, `${tool} with ${JSON.stringify(scopes)}: ${r.content[0].text.slice(0, 120)}`).toBe(!allowed);
          if (!allowed) {
            expect(r.content[0].text).toMatch(/^(Unauthorized \(401\)|Forbidden \(403\))/);
            expect(await snapshot(payments)).toEqual(before);
          }
        }),
        { numRuns: 200 },
      );
    },
    240_000,
  );
});

describe("search_docs tool", () => {
  it(
    "never errors for any 2..200 character query and respects the limit (default 3)",
    async () => {
      const call = tools(null, createFakeStripe("sk_test_property"));
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string({ minLength: 2, maxLength: 200 }),
            fc.fullUnicodeString({ minLength: 2, maxLength: 200 }).filter((s) => s.length <= 200),
            fc.constantFrom("refund early-bird tickets", "how do API key scopes work", "service fee VAT", "the is a", "__proto__"),
          ),
          fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
          async (query, limit) => {
            const r = await call("search_docs", limit === undefined ? { query } : { query, limit });
            expect(r.isError).toBeFalsy();
            const res = JSON.parse(r.content[0].text);
            expect(res.results.length).toBeLessThanOrEqual(limit ?? 3);
            for (const hit of res.results) {
              expect(hit.source).toMatch(/^help\/[a-z0-9-]+\.md$/);
              expect(hit.text.length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    120_000,
  );
});
