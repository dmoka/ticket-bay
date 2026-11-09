// TEMPORARY scaffolding (approval tests): the whole export — CSV, printable copy,
// mails and JSON — for one fixed month, compared byte for byte with the approved
// files in __approved__/. Delete once the functional tests in
// invoice-export.test.ts cover what these catch.
import { describe, it, expect } from "vitest";
import { buildInvoiceExport, type InvoiceOrderRow } from "../../src/domain/invoice-export";

const venues = ["A38 Ship", "Budapest Park", "Hungexpo Hall G", "Kisüzem", "MVM Dome", "New Venue, Szeged", "Opus Jazz Club", "Zamárdi Beach"];
const customers = ["Anna Kovács", 'Béla "Bé" Nagy', "Smith, John", "Zsófia Tóth-Horváthné Kiss-Szabó", "李雷", "O'Brien"];
const grosses = [11700, 999, 50, 12700, 123456789, 4321, 100, 199999, 7];

const rows: InvoiceOrderRow[] = [];
let id = 1;
for (const venue of venues) {
  for (let k = 0; k < 3; k++, id++) {
    const tickets = grosses[id % grosses.length];
    const discount = (id * 37) % 500;
    rows.push({
      id,
      event_id: "event-" + (id % 4),
      event_name: id % 5 === 0 ? "Jazz, live\nat night" : "Event " + (id % 4),
      venue,
      customer_name: customers[id % customers.length],
      customer_email: "c" + id + "@example.com",
      quantity: (id % 7) + 1,
      subtotal_cents: String(tickets + discount),
      discount_cents: String(discount),
      tickets_cents: String(tickets),
      created_at_ms: String(Date.UTC(2026, 9, 1) + id * 86_400_000 + id * 3_600_000 - 1),
    });
  }
}

describe("TEMPORARY approval: invoice export for October 2026", () => {
  let seq = 501;
  const out = buildInvoiceExport({ rows, month: "2026-10", now: new Date("2026-11-01T06:00:00.000Z"), nextInvoiceSeq: () => seq++ });

  it("the CSV", async () => {
    await expect(out.csv).toMatchFileSnapshot("__approved__/invoice-export.csv");
  });
  it("the printable copy", async () => {
    await expect(out.txt).toMatchFileSnapshot("__approved__/invoice-export.txt");
  });
  it("the mails", async () => {
    await expect(out.mails.map((m) => "To: " + m.to + "\nSubject: " + m.subject + "\n\n" + m.body).join("-----\n")).toMatchFileSnapshot(
      "__approved__/invoice-export.mails.txt",
    );
  });
  it("the JSON result", async () => {
    await expect(JSON.stringify(out.result, null, 2) + "\n").toMatchFileSnapshot("__approved__/invoice-export.json");
  });
});
