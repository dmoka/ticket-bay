// TEMPORARY approval test (legacy-testing, step 3): the whole CSV, printable
// copy and outbox for one fixed month, approved once as the files under
// __snapshots__. A net for the refactor of src/finance/invoices.ts; delete it
// once the functional tests in invoices.test.ts cover every line of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { orders } from "../../src/db/schema";
import { invoiceExport } from "../../src/finance/invoices";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";

const t = useTestDatabase();

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoices-approval-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function order(eventId: string, over: Partial<typeof orders.$inferInsert>) {
  await t.db.insert(orders).values({
    eventId,
    customerEmail: `fan${++n}@example.com`,
    customerName: "A Fan",
    quantity: 1,
    subtotalCents: 10_000,
    discountPercent: 0,
    discountCents: 0,
    ticketsCents: 10_000,
    feeCents: 300,
    totalCents: 10_300,
    vatCents: 2_189,
    paymentId: `ch_${n}`,
    idempotencyKey: `approval-${n}`,
    createdAtMs: NOW,
    ...over,
  });
}

it("the January 2027 export, approved", async () => {
  await venue(t.db, { id: "park", venue: "Budapest Park", name: "Park Night" });
  await venue(t.db, { id: "beach", venue: "Zamárdi Beach", name: "Beach Fest, day 2" });
  await venue(t.db, { id: "arena", venue: "Arena", name: "RockFest 2026" });
  await order("park", { customerName: "Kiss Anna", quantity: 2, subtotalCents: 12_345, ticketsCents: 12_345, feeCents: 370, totalCents: 12_715 });
  await order("arena", { customerName: 'Kovács, "Jr." Ádám', createdAtMs: Date.UTC(2027, 0, 1) });
  await order("beach", { customerName: "Dr. Nagy-Kovács Erzsébet Mária", quantity: 5, subtotalCents: 25_000, discountPercent: 5, discountCents: 1_250, ticketsCents: 23_750, feeCents: 713, totalCents: 24_463 });
  await order("park", { customerName: "Tóth Béla", createdAtMs: Date.UTC(2027, 0, 31, 23, 59) });
  await order("park", { status: "refunded", refundedAtMs: NOW, refundCents: 9_800, refundFeeCents: 200, refundReason: "customer" });
  await order("arena", { createdAtMs: Date.UTC(2027, 1, 1) });

  let next = 1;
  const result = await invoiceExport({ month: "2027-01", event: null }, { db: t.db, nowMs: NOW, dir, sequence: { next: () => next++ } });

  await expect(fs.readFileSync(path.join(dir, "invoices-2027-01.csv"), "utf8")).toMatchFileSnapshot("__snapshots__/invoices-2027-01.csv");
  await expect(fs.readFileSync(path.join(dir, "invoices-2027-01.txt"), "utf8")).toMatchFileSnapshot("__snapshots__/invoices-2027-01.txt");
  await expect(fs.readFileSync(path.join(dir, "outbox.log"), "utf8")).toMatchFileSnapshot("__snapshots__/invoices-2027-01-outbox.log");
  // the JSON, with the folder-dependent file paths taken out
  await expect(JSON.stringify({ ...result, files: result.files.map((f: string) => path.basename(f)) }, null, 2)).toMatchFileSnapshot("__snapshots__/invoices-2027-01.json");
});
