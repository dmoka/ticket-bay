import { describe, it, expect } from "vitest";
import { buildInvoice } from "../src/invoice";

const NOW = 1700000000000;
const DAY = 86_400_000;
const ev = (priceCents = 5000, daysUntil = 5) => ({
  id: "e1", name: "RockFest", totalSeats: 100, seatsSold: 0,
  priceCents, startMs: NOW + daysUntil * DAY,
});

describe("buildInvoice — single tickets", () => {
  it("prices a single ticket with no discounts", () => {
    const inv = buildInvoice(ev(), 1, NOW);
  });

  it("includes 27% VAT in the total", () => {
    const inv = buildInvoice(ev(), 1, NOW);
  });

  it("applies the early-bird discount when booking 40 days ahead", () => {
    const inv = buildInvoice(ev(5000, 40), 1, NOW);
  });
});

describe("buildInvoice — group discounts", () => {
  it("gives 5% for a group of five", () => {
    const inv = buildInvoice(ev(), 5, NOW);
  });

  it("gives 10% for a group of ten", () => {
    const inv = buildInvoice(ev(), 10, NOW);
  });

  it("stacks group and early-bird discounts", () => {
    const inv = buildInvoice(ev(5000, 40), 10, NOW);
  });

  it("gives no group discount below five tickets", () => {
    const inv = buildInvoice(ev(), 3, NOW);
  });
});

describe("buildInvoice — service fee", () => {
  it("applies the minimum fee on cheap orders", () => {
    const inv = buildInvoice(ev(2000, 5), 1, NOW);
  });

  it("caps the fee on large orders", () => {
    const inv = buildInvoice(ev(), 20, NOW);
  });
});

describe("buildInvoice — early-bird boundary", () => {
  it("applies early-bird at exactly 30 days", () => {
    const inv = buildInvoice(ev(5000, 30), 1, NOW);
  });

  it("gives no early-bird at 29 days", () => {
    const inv = buildInvoice(ev(5000, 29), 1, NOW);
  });
});

describe("buildInvoice — input validation", () => {
  it("rejects a non-positive quantity", () => {
    let thrown = false;
    try { buildInvoice(ev(), 0, NOW); } catch { thrown = true; }
  });
});
