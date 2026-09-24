import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { money, orderNumber } from "../../lib/format";

describe("money", () => {
  it("formats integer cents as euros with two decimals", () => {
    expect(money(0)).toBe("€0.00");
    expect(money(5)).toBe("€0.05");
    expect(money(9_800)).toBe("€98.00");
    expect(money(264_600)).toBe("€2,646.00");
    expect(money(-250)).toBe("−€2.50");
  });

  it("is exact at the top of the safe-integer range, where cents / 100 is not", () => {
    expect(money(Number.MAX_SAFE_INTEGER)).toBe("€90,071,992,547,409.91");
  });

  it("round-trips: the digits shown are exactly the cents stored", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (c) => {
        expect(Number(money(c).replace(/[€,.]/g, ""))).toBe(c);
      }),
    );
  });
});

describe("orderNumber", () => {
  it("pads to five digits", () => {
    expect(orderNumber(42)).toBe("TB-00042");
  });
});
