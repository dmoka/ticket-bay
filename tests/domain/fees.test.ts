import { describe, it, expect } from "vitest";
import { serviceFee, vatPortion } from "../../src/domain/fees";

describe("serviceFee", () => {
  it("charges 3% on a normal order", () => {
    expect(serviceFee(10000)).toBe(300);
  });
});

describe("vatPortion", () => {
  it("extracts 27% VAT from a gross price", () => {
    expect(vatPortion(12700, 27)).toBe(2700);
  });
});
