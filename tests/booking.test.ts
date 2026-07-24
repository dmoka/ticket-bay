// AI-style suite: plausible, green, round numbers, no boundaries.
import { describe, it, expect } from "vitest";
import { seatsAvailable, bookTickets, groupDiscount } from "../src/booking";

const ev = () => ({ id: "e1", name: "RockFest", totalSeats: 100, seatsSold: 40, priceCents: 5000 });

describe("seatsAvailable", () => {
  it("returns remaining seats", () => {
    expect(seatsAvailable(ev())).toBe(60);
  });
  it("returns 0 for a sold-out event", () => {
    expect(seatsAvailable({ ...ev(), seatsSold: 100 })).toBe(0);
  });
});

describe("bookTickets", () => {
  it("books two tickets at full price", () => {
    const o = bookTickets(ev(), 2);
    expect(o.totalCents).toBe(10000);
    expect(o.tickets).toBe(2);
  });
  it("applies a percentage discount", () => {
    const o = bookTickets(ev(), 2, 50);
    expect(o.totalCents).toBe(5000);
  });
  it("throws when booking zero tickets", () => {
    expect(() => bookTickets(ev(), 0)).toThrow();
  });
  it("throws when not enough seats", () => {
    expect(() => bookTickets(ev(), 61)).toThrow();
  });
});

describe("groupDiscount", () => {
  it("gives no discount for small groups", () => {
    expect(groupDiscount(2)).toBe(0);
  });
  it("gives 5% for groups of five", () => {
    expect(groupDiscount(5)).toBe(5);
  });
  it("gives 10% for groups of ten", () => {
    expect(groupDiscount(10)).toBe(10);
  });
});
