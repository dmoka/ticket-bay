import { describe, it, expect } from "vitest";
import { money, orderNumber } from "../../lib/format";

describe("money", () => {
  it("formats integer cents as euros with two decimals", () => {
    expect(money(0)).toBe("€0.00");
    expect(money(9_800)).toBe("€98.00");
    expect(money(264_600)).toBe("€2,646.00");
    expect(money(-250)).toBe("−€2.50");
  });

  it("is exact at the top of the safe-integer range, where cents / 100 is not", () => {
    expect(money(Number.MAX_SAFE_INTEGER)).toBe("€90,071,992,547,409.91");
  });
});

describe("orderNumber", () => {
  it("pads to five digits", () => {
    expect(orderNumber(42)).toBe("TB-00042");
  });
});
