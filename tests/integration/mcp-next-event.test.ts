// my_next_event through the route's POST with a real Request, real Better Auth
// keys and real Postgres (Testcontainers): the soonest upcoming event the
// caller holds PAID tickets for, with the tickets of every paid order for it
// added up. Refunded orders, past events and other customers' orders do not
// count. No upcoming paid tickets is an answer (next_event: null), not an error.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeStripe } from "../../src/payments";
import type { Auth } from "../../src/auth/auth";
import { placeOrder } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { DAY, HOUR, venue } from "./fixtures";
import { bearer, customer, makeAuth, readReply, scopedKey, toolCallRequest, toolResult, useCleanAccounts } from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as any, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));
vi.mock("@/src/mcp/caller", () => import("../../src/mcp/caller"));
vi.mock("@/src/mcp/tools", () => import("../../src/mcp/tools"));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));

const t = useTestDatabase();
useCleanAccounts(t);

let auth: Auth;
let POST: (r: Request) => Promise<Response>;
const payments = createFakeStripe("sk_test_integration");

beforeAll(async () => {
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = payments;
  ({ POST } = await import("../../app/api/mcp/route"));
});

const call = async (name: string, args: object = {}, headers: Record<string, string> = {}) => readReply(await POST(toolCallRequest(name, args, headers)));

/** An event `days` from now (the route's clock is the real one), 100 seats, €50.00. */
const eventIn = (days: number, over: Parameters<typeof venue>[1] = {}) =>
  venue(t.db, { startsAtMs: Date.now() + days * DAY, createdAtMs: Date.now() - 60 * DAY, ...over });

let keys = 0;
/** A paid order placed at `atMs` (default: now) for the user, straight through the service. */
async function paid(userId: string, email: string, eventId: string, quantity: number, atMs = Date.now()) {
  const { order } = await placeOrder({ db: t.db, payments, nowMs: atMs }, { eventId, quantity, email, name: "Fan", userId, idempotencyKey: `next-${++keys}` });
  return order;
}

describe("my_next_event", () => {
  it("is the soonest upcoming event with paid tickets, every paid order for it added up — refunded, past and other customers' orders left out", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const later = await eventIn(10, { name: "Later Fest" });
    const soon = await eventIn(5, { name: "Soon Night" });
    const gone = await eventIn(-1, { name: "Yesterday Show" });

    await paid(anna.id, anna.email, later.id, 2);
    const keep = await paid(anna.id, anna.email, soon.id, 3);
    const refunded = await paid(anna.id, anna.email, soon.id, 1);
    await paid(anna.id, anna.email, gone.id, 4, Date.now() - 2 * DAY); // booked before it started, now over
    await paid(bela.id, bela.email, soon.id, 5);
    expect(toolResult(await call("refund_order", { order_id: refunded.id }, bearer(anna.key))).isError).toBe(false);

    const r = toolResult(await call("my_next_event", {}, bearer(anna.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toEqual({
      customer: anna.email,
      next_event: {
        id: soon.id,
        name: "Soon Night",
        venue: "Arena",
        city: "Budapest",
        starts_at: expect.any(String),
        url: `http://localhost:3000/events/${soon.id}`,
      },
      tickets: 3,
      orders: [{ order_number: `TB-${String(keep.id).padStart(5, "0")}`, tickets: 3, url: `http://localhost:3000/orders/${keep.id}` }],
    });
  });

  it("adds up several paid orders for the same event, and the event starting first wins even when it was booked last", async () => {
    const anna = await customer(auth, "Anna");
    const first = await eventIn(3);
    const second = await eventIn(4);
    await paid(anna.id, anna.email, second.id, 1);
    const a = await paid(anna.id, anna.email, first.id, 2);
    const b = await paid(anna.id, anna.email, first.id, 4);

    const r = toolResult(await call("my_next_event", {}, bearer(anna.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data.next_event.id).toBe(first.id);
    expect(r.data.tickets).toBe(6);
    expect(r.data.orders.map((o: { tickets: number }) => o.tickets).sort()).toEqual([2, 4]);
    expect(r.data.orders.map((o: { url: string }) => o.url).sort()).toEqual([a.id, b.id].map((id) => `http://localhost:3000/orders/${id}`).sort());
  });

  it("an event that has just started is not 'next'; one about to start is", async () => {
    const anna = await customer(auth, "Anna");
    const started = await venue(t.db, { startsAtMs: Date.now() - 1000, createdAtMs: Date.now() - 60 * DAY });
    const starting = await venue(t.db, { startsAtMs: Date.now() + HOUR, createdAtMs: Date.now() - 60 * DAY });
    await paid(anna.id, anna.email, started.id, 1, Date.now() - HOUR);
    await paid(anna.id, anna.email, starting.id, 2);

    const r = toolResult(await call("my_next_event", {}, bearer(anna.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ next_event: { id: starting.id }, tickets: 2 });
  });

  it("no upcoming paid tickets is next_event: null, not an error — for no orders, only refunded ones, or only past events", async () => {
    const anna = await customer(auth, "Anna");
    const none = toolResult(await call("my_next_event", {}, bearer(anna.key)));
    expect(none.isError, none.text).toBe(false);
    expect(none.data).toEqual({ customer: anna.email, next_event: null, note: expect.stringMatching(/no paid tickets/i) });

    const ev = await eventIn(7);
    const gone = await eventIn(-1);
    const o = await paid(anna.id, anna.email, ev.id, 2);
    await paid(anna.id, anna.email, gone.id, 2, Date.now() - 2 * DAY);
    expect(toolResult(await call("refund_order", { order_id: o.id }, bearer(anna.key))).isError).toBe(false);

    const r = toolResult(await call("my_next_event", {}, bearer(anna.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data.next_event).toBeNull();
    expect(r.data).not.toHaveProperty("tickets");
  });

  it("needs a key that can read: a read-only key works, no key is a 401, a key without tickets:read is a 403", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await eventIn(7);
    await paid(anna.id, anna.email, ev.id, 2);

    const ro = await scopedKey(auth, anna.id, "read");
    const r = toolResult(await call("my_next_event", {}, bearer(ro.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ next_event: { id: ev.id }, tickets: 2 });

    const anon = await call("my_next_event", {});
    expect(anon.status).toBe(401);

    const odd = await auth.api.createApiKey({ body: { name: "odd", userId: anna.id, permissions: { other: ["thing"] } } });
    const refused = toolResult(await call("my_next_event", {}, bearer(odd.key)));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Forbidden \(403\)/);
    expect(refused.text).toContain("tickets:read");
    expect(refused.text).not.toContain(ev.id);
  });
});
