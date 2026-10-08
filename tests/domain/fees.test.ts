import { describe, it, expect } from "vitest";
import { serviceFee, vatPortion } from "../../src/domain/fees";

describe("serviceFee", () => {
  it("charges 3% on a normal order", () => {
    expect(serviceFee(10000)).toBe(300);
  });
  it("applies the minimum fee on small orders", () => {
    expect(serviceFee(1000)).toBe(100);
  });
  it("caps the fee on huge orders", () => {
    expect(serviceFee(100000)).toBe(2000);
  });
  it("charges the minimum when 3% comes to 99 cents", () => {
    expect(serviceFee(3300)).toBe(100);
  });
  it("caps the fee when 3% comes to 2001 cents", () => {
    expect(serviceFee(66700)).toBe(2000);
  });
});

describe("vatPortion", () => {
  it("extracts 27% VAT from a gross price", () => {
    expect(vatPortion(12700, 27)).toBe(2700);
  });
  it("extracts 20% VAT from a gross price", () => {
    expect(vatPortion(12000, 20)).toBe(2000);
  });
});
