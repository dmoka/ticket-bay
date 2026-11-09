// Crash hunt on GET /api/v1/organizer/invoices at the HTTP level: generated
// queries (any month, any event id, repeated parameters), callers (no key, a
// bad key, a customer's or an admin's read-only or read-write key) and data
// states (no events or orders at all, events at known, unknown and
// Object.prototype-named venues, paid and refunded orders of any amount from
// €0, in and around the month), through the real route handler and Postgres.
// The property: the status is below 500 and the body is JSON — the export on
// a 200, {"error": "..."} otherwise; only an admin gets a 200.
//
// Every run picks a new random seed; FC_SEED=<n> replays a failing run. The
// export's files and mails go to a temporary directory, not reports/.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import type { Auth } from "../../src/auth/auth";
import { invoiceMonth, isInvoiceMonth } from "../../src/domain/invoice-export";
import { events, orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAdmin, makeAuth, scopedKey, useCleanAccounts } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { NOW, venue as createVenue } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs } from "./client";
import { anyMonth, month as validMonth, venue as venueName, text } from "../domain/invoice-export.arbitraries";

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

const SEED = Number(process.env.FC_SEED ?? Math.floor(Math.random() * 2 ** 31));
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

let auth: Auth;
let outDir: string;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  vi.spyOn(console, "log").mockImplementation(() => {});
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ticketbay-invoices-"));
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
  vi.restoreAllMocks();
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** An order around the month: where it falls, what it cost, whether it is still paid. */
const order = fc.record({
  event: fc.nat(),
  when: fc.constantFrom("first ms", "inside", "last ms", "before", "after"),
  ticketsCents: fc.oneof(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  subtotalExtra: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 1_000_000 })),
  subtotalZero: fc.boolean(),
  refunded: fc.boolean(),
  customerName: text,
  customerEmail: text,
  quantity: fc.integer({ min: 1, max: 50 }),
});

const scenario = fc.record({
  venues: fc.array(fc.record({ venue: venueName, name: text }), { maxLength: 4 }),
  orders: fc.array(order, { maxLength: 6 }),
  // weighted towards a month, so most runs reach the export
  month: fc.option(fc.oneof({ weight: 3, arbitrary: validMonth }, { weight: 1, arbitrary: anyMonth }), { nil: undefined }),
  repeatMonth: fc.boolean(),
  // weighted towards a query that reaches the export
  event: fc.oneof(
    { weight: 3, arbitrary: fc.constant({ kind: "none" as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: "empty" as const }) },
    { weight: 3, arbitrary: fc.nat().map((i) => ({ kind: "seeded" as const, i })) },
    fc
      .oneof(text, fc.constantFrom("no-such-event", "UPPER", "a_b", "-x", "a".repeat(100), "a".repeat(101), "../x", "%00", "a b"))
      .map((raw) => ({ kind: "raw" as const, raw })),
  ),
  who: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom("admin read key", "admin read-write key") },
    { weight: 1, arbitrary: fc.constantFrom("none", "bad key", "not bearer", "customer read key", "customer read-write key") },
  ),
  /** an order of the event asked for in the month, so most exports have lines — or none */
  anchor: fc.constantFrom("first ms", "inside", "last ms", "none"),
});

type Scenario = typeof scenario extends fc.Arbitrary<infer S> ? S : never;

function at(when: string, start: number, end: number) {
  if (when === "first ms") return start;
  if (when === "last ms") return end - 1;
  if (when === "before") return start - 1;
  if (when === "after") return end;
  return start + Math.floor((end - start) / 2);
}

function wallClockMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1);
}

let n = 0;
async function seed(s: Scenario) {
  await t.db.delete(orders);
  await t.db.delete(events);
  const ids: string[] = [];
  for (const [i, v] of s.venues.entries()) {
    const ev = await createVenue(t.db, { id: `ev-${i}-${++n}`, venue: v.venue, name: v.name });
    ids.push(ev.id);
  }
  // a month that is not one gets a 400 before any row is read: seed around October 2026 then
  const m = s.month ?? wallClockMonth();
  const { start, end } = isInvoiceMonth(m) ? invoiceMonth(m) : invoiceMonth("2026-10");
  const insert = (o: Partial<typeof orders.$inferInsert> & { eventId: string; createdAtMs: number }) =>
    t.db.insert(orders).values({
      customerEmail: "fan@example.com",
      customerName: "A Fan",
      quantity: 1,
      subtotalCents: 11700,
      discountPercent: 0,
      discountCents: 0,
      ticketsCents: 11700,
      feeCents: 351,
      totalCents: 12051,
      vatCents: 2487,
      paymentId: `ch_${++n}`,
      idempotencyKey: `prop-${n}`,
      ...o,
    });
  for (const o of ids.length > 0 ? s.orders : []) {
    const subtotal = o.subtotalZero ? 0 : o.ticketsCents + o.subtotalExtra;
    await insert({
      eventId: ids[o.event % ids.length] ?? "",
      createdAtMs: at(o.when, start.getTime(), end.getTime()),
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      quantity: o.quantity,
      ticketsCents: o.ticketsCents,
      subtotalCents: subtotal,
      discountCents: Math.max(subtotal - o.ticketsCents, 0),
      totalCents: o.ticketsCents,
      status: o.refunded ? "refunded" : "paid",
    });
  }
  const eventId = s.event.kind === "seeded" ? ids[s.event.i % ids.length] : ids[0];
  if (s.anchor !== "none" && eventId) await insert({ eventId, createdAtMs: at(s.anchor, start.getTime(), end.getTime()) });
  return ids;
}

describe("crash hunt: GET /api/v1/organizer/invoices", () => {
  it("any query, caller and data: status below 500 and a JSON body", async () => {
    const admin = await customer(auth);
    await makeAdmin(t.db, admin.id);
    const plain = await customer(auth);
    // a fresh key per run: a key is rate-limited to 120 requests a minute (src/auth/auth.ts)
    const headers = async (who: string): Promise<Record<string, string>> => {
      if (who === "admin read key") return bearer((await scopedKey(auth, admin.id, "read")).key);
      if (who === "admin read-write key") return bearer((await scopedKey(auth, admin.id, "read-write")).key);
      if (who === "customer read key") return bearer((await scopedKey(auth, plain.id, "read")).key);
      if (who === "customer read-write key") return bearer((await scopedKey(auth, plain.id, "read-write")).key);
      if (who === "bad key") return bearer("tb_nope");
      if (who === "not bearer") return { authorization: "Basic eDp5" };
      return {};
    };

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(outDir);
    try {
      await fc.assert(
        fc.asyncProperty(scenario, async (s) => {
          const ids = await seed(s);
          const q = new URLSearchParams();
          if (s.month !== undefined) {
            q.append("month", s.month);
            if (s.repeatMonth) q.append("month", "2026-10");
          }
          if (s.event.kind === "empty") q.append("event", "");
          if (s.event.kind === "seeded") q.append("event", ids[s.event.i % ids.length] ?? "no-events-yet");
          if (s.event.kind === "raw") q.append("event", s.event.raw);
          const qs = q.toString();

          const r = await call({ path: "/api/v1/organizer/invoices" + (qs ? "?" + qs : ""), headers: await headers(s.who), nowMs: NOW });
          expect(r.status, r.text).toBeLessThan(500);
          expect(r.isJson, r.text).toBe(true);
          if (r.status === 200) {
            expect(s.who.startsWith("admin"), "only an admin gets the export").toBe(true);
            expect(r.body.totals.invoices).toBe(r.body.organizers.reduce((n: number, g: { lines: unknown[] }) => n + g.lines.length, 0));
          } else {
            expect(typeof r.body.error).toBe("string");
          }
        }),
        runs(Number(process.env.FC_RUNS ?? 50)),
      );
    } finally {
      cwd.mockRestore();
    }
  }, 300_000);
});
