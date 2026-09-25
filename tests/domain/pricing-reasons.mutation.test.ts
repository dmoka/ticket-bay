// Mutation-tester lane. A customer whose code is refused must be told WHY, so
// they know whether to try another code or stop trying: an expired code and a
// used-up code get their own message, never a blank one.
import { describe, it, expect } from "vitest";
import { checkDiscountCode, type DiscountCode } from "../../src/domain/pricing";

const NOW = 1_800_000_000_000;
const code = (over: Partial<DiscountCode> = {}): DiscountCode => ({
  code: "WELCOME10",
  percent: 10,
  active: true,
  maxUses: null,
  uses: 0,
  expiresAtMs: null,
  ...over,
});

describe("a refused discount code tells the customer why", () => {
  it("says the code has expired", () => {
    expect(checkDiscountCode("welcome10", code({ expiresAtMs: NOW }), NOW)).toEqual({
      ok: false,
      code: "WELCOME10",
      reason: "This code has expired.",
    });
  });

  it("says the code has been fully redeemed", () => {
    expect(checkDiscountCode("welcome10", code({ maxUses: 3, uses: 3 }), NOW)).toEqual({
      ok: false,
      code: "WELCOME10",
      reason: "This code has been fully redeemed.",
    });
  });
});
