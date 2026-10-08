// GET /api/v1/organizer/invoices end to end: real Requests into the route
// handler, real Better Auth API keys, real Postgres (Testcontainers) — the
// same wiring as api-v1.test.ts. Pinned as it answers today, suspected bugs
// included. The route writes its files to ./reports (gitignored).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Auth } from "../../src/auth/auth";
import { orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, revokeKey, scopedKey, useCleanAccounts } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { NOW, venue } from "../integration/fixtures";
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

const get = (query: string, headers: Record<string, string> = {}, nowMs = NOW) => call({ path: `/api/v1/organizer/invoices${query}`, headers, nowMs });

let n = 0;
/** A paid order of €100.00 of tickets, placed at NOW (January 2027). */
async function order(eventId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  await t.db.insert(orders).values({
    eventId,
    customerEmail: "fan@example.com",
    customerName: "A Fan",
    quantity: 1,
    subtotalCents: 10_000,
    discountPercent: 0,
    discountCents: 0,
    ticketsCents: 10_000,
    feeCents: 300,
    totalCents: 10_300,
    vatCents: 2_189,
    paymentId: `ch_${++n}`,
    idempotencyKey: `http-inv-${n}`,
    createdAtMs: NOW,
    ...over,
  });
}

const SERVER_ERROR = { error: "Something went wrong on our side. Try again later." };

describe("GET /api/v1/organizer/invoices", () => {
  it("needs an API key: 401 without one, 401 with a revoked one", async () => {
    const r = await get("?month=2027-01");
    expect(r).toMatchObject({ status: 401, body: { error: expect.stringContaining("needs an API key") } });
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="TicketBay API"');

    const gone = await customer(auth, "Gone");
    await revokeKey(auth, gone);
    expect((await get("?month=2027-01", bearer(gone.key))).status).toBe(401);
  });

  it("answers the month's export as JSON: the batch, one block per organizer, the lines in cents, the totals, the files, the mails", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park", name: "Park Night" });
    await order("park");
    const anna = await customer(auth, "Anna");

    const r = await get("?month=2027-01", bearer(anna.key));
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.body).toMatchObject({
      batchId: "INV-2027-01-1",
      month: "2027-01",
      organizers: [{ organizer: "Park Live Events Kft.", lines: [{ invoiceNo: expect.stringMatching(/^TB-202701-\d{6}$/), grossCents: 10_000, vatCents: 2_126, netCents: 7_874 }] }],
      totals: { invoices: 1, netCents: 7_874, vatCents: 2_126, grossCents: 10_000 },
      files: ["reports/invoices-2027-01.csv", "reports/invoices-2027-01.txt"],
      emailsSent: 1,
    });
  });

  it("without ?month the export is the request clock's month", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park" });
    await order("park");
    const anna = await customer(auth, "Anna");
    const r = await get("", bearer(anna.key), NOW);
    expect(r.status, r.text).toBe(200);
    expect(r.body.month).toBe("2027-01");
  });

  it("?event= limits the export to one event; an id that is not an event id is a 404", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park" });
    await venue(t.db, { id: "beach", venue: "Zamárdi Beach" });
    await order("park");
    await order("beach");
    const anna = await customer(auth, "Anna");
    const one = await get("?month=2027-01&event=park", bearer(anna.key));
    expect(one.status, one.text).toBe(200);
    expect(one.body.totals.invoices).toBe(1);
    expect(await get("?month=2027-01&event=NOT%20AN%20ID", bearer(anna.key))).toMatchObject({ status: 404, body: { error: "Event not found." } });
  });

  it("pins current behaviour — suspected bug: any customer's key, a read-only one included, reads every organizer's invoices with every customer's name and e-mail", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park" });
    await order("park", { customerName: "Kiss Anna", customerEmail: "anna@example.com" });
    const bela = await customer(auth, "Bela");
    const readOnly = await scopedKey(auth, bela.id, "read");
    const r = await get("?month=2027-01", bearer(readOnly.key));
    expect(r.status, r.text).toBe(200);
    expect(r.body.organizers[0].lines[0]).toMatchObject({ customer: "Kiss Anna", customerEmail: "anna@example.com" });
  });

  it("a month with no paid orders is an empty export: 200, no block, zero totals, no mail", async () => {
    const anna = await customer(auth, "Anna");
    const r = await get("?month=2027-01", bearer(anna.key));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ batchId: "INV-2027-01-0", month: "2027-01", organizers: [], totals: { invoices: 0, netCents: 0, vatCents: 0, grossCents: 0 }, emailsSent: 0 });
  });

  it("without ?month, a request clock outside the orders' month is that month's empty export; a junk clock cookie falls back to the wall clock", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park" });
    await order("park");
    const anna = await customer(auth, "Anna");
    const june = await get("?event=park", bearer(anna.key), Date.UTC(2027, 5, 1));
    expect(june.status, june.text).toBe(200);
    expect(june.body).toMatchObject({ month: "2027-06", totals: { invoices: 0 } });
    const junkClock = await call({ path: "/api/v1/organizer/invoices", headers: { ...bearer(anna.key), cookie: "tb-test-now=not-a-time" } });
    expect(junkClock.status, junkClock.text).toBe(200);
    const today = new Date(); // the default month is the server's local month
    expect(junkClock.body.month).toBe(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
  });

  it("a ?month that is not a month is a 400 that says the format; YYYY-M is taken, an empty ?month= means the clock's month", async () => {
    const anna = await customer(auth, "Anna");
    for (const bad of ["banana", "2027", "2027-", "2027-13", "2027-00", "2027-01-15", "1969-12", "99999-01", " 2027-01", "2027-1.5"]) {
      expect(await get(`?month=${encodeURIComponent(bad)}`, bearer(anna.key)), bad).toMatchObject({ status: 400, body: { error: "month: must be a month like 2027-01." } });
    }
    expect(await get("?month=%ZZ", bearer(anna.key))).toMatchObject({ status: 400, body: { error: "month: must be a month like 2027-01." } });
    expect((await get("?month=2027-1", bearer(anna.key))).body.month).toBe("2027-01");
    expect((await get("?month=", bearer(anna.key))).body.month).toBe("2027-01");
  });

  it("pins current behaviour — suspected bug: a free order in the month is a 500", async () => {
    await venue(t.db, { id: "park", venue: "Budapest Park" });
    await order("park", { discountPercent: 100, discountCents: 10_000, ticketsCents: 0, feeCents: 100, totalCents: 100 });
    const anna = await customer(auth, "Anna");
    expect(await get("?month=2027-01", bearer(anna.key))).toMatchObject({ status: 500, body: SERVER_ERROR });
  });
});
