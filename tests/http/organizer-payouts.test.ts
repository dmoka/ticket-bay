// GET /api/v1/organizer/payouts: who may call it. Real Requests into the route
// handler, real Better Auth API keys, real Postgres (Testcontainers). The
// report itself has no tests yet; this file pins only its access rule.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Auth } from "../../src/auth/auth";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAdmin, makeAuth, scopedKey, useCleanAccounts } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { NOW } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs } from "./client";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));

const t = useTestDatabase();
useCleanAccounts(t);
quietRefusedKeyLogs();

let auth: Auth;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

const payouts = (query: string, headers: Record<string, string> = {}) => call({ path: "/api/v1/organizer/payouts" + query, headers, nowMs: NOW });

describe("GET /api/v1/organizer/payouts — who may call it", () => {
  it("without a key: 401", async () => {
    expect((await payouts("?organizer=A38%20Ship")).status).toBe(401);
  });

  it("a customer's key, read-only or read-write: 403", async () => {
    const c = await customer(auth);
    const readOnly = (await scopedKey(auth, c.id, "read")).key;
    for (const key of [c.key, readOnly]) {
      const r = await payouts("?organizer=A38%20Ship", bearer(key));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "The organizer reports are for TicketBay admins only." });
    }
  });

  it("an admin's key gets past the check: the query is judged next", async () => {
    const c = await customer(auth);
    await makeAdmin(t.db, c.id);
    const r = await payouts("", bearer(c.key));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Send ?event=<event id> or ?organizer=<venue>." });
  });
});
