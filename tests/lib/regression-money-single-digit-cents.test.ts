import { describe, it, expect } from "vitest";
import { money } from "../../lib/format";

// Reported: a 3-ticket order of €135.00 carries a €4.05 fee and a €139.05
// total (that is what the card was charged), but checkout and the order page
// showed "€4.50" and "€139.50". Amounts whose cents part is a single digit
// must keep the leading zero.
describe("money keeps the leading zero in the cents part", () => {
  it("formats a fee of 405 cents as €4.05, not €4.50", () => {
    expect(money(405)).toBe("€4.05");
  });

  it("formats an order total of 13905 cents as €139.05", () => {
    expect(money(13_905)).toBe("€139.05");
  });

  it("formats negative amounts with single-digit cents the same way", () => {
    expect(money(-405)).toBe("−€4.05");
  });

  it("formats exact single cents", () => {
    expect(money(1)).toBe("€0.01");
    expect(money(100_001)).toBe("€1,000.01");
  });
});
