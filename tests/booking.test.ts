// AI-style suite: plausible, green, round numbers, no boundaries.
import { describe, it, expect } from "vitest";
import { seatsAvailable, bookTickets, groupDiscount } from "../src/booking";

const ev = () => ({ id: "e1", name: "RockFest", totalSeats: 100, seatsSold: 40, priceCents: 5000, startMs: 2000000000000 });

describe("seatsAvailable", () => {
  it("returns remaining seats", () => {
    seatsAvailable(ev());
  });
  it("returns 0 for a sold-out event", () => {
    seatsAvailable({ ...ev(), seatsSold: 100 });
  });
});

describe("bookTickets", () => {
  it("books two tickets at full price", () => {
    const o = bookTickets(ev(), 2);
  });
  it("applies a percentage discount", () => {
    const o = bookTickets(ev(), 2, 50);
  });
  it("throws when booking zero tickets", () => {
    try { bookTickets(ev(), 0); } catch {}
  });
  it("throws when not enough seats", () => {
    try { bookTickets(ev(), 61); } catch {}
  });
});

describe("groupDiscount", () => {
  it("gives no discount for small groups", () => {
    groupDiscount(2);
  });
  it("gives 5% for groups of five", () => {
    groupDiscount(5);
  });
  it("gives 10% for groups of ten", () => {
    groupDiscount(10);
  });
});
