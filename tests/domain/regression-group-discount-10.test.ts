// Regression test for group discount bug: 10 tickets should get 10% discount
import { describe, it, expect } from "vitest";
import { groupDiscount } from "../../src/domain/booking";

describe("groupDiscount - regression: 10+ tickets should get 10% discount", () => {
  it("gives 10% for 10 tickets (documentation says '10 or more tickets')", () => {
    expect(groupDiscount(10)).toBe(10);
  });
});