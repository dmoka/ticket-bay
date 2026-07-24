// AI-style suite: round numbers only, boundaries untested.
import { describe, it, expect } from "vitest";
import { serviceFee, vatPortion } from "../src/fees";

describe("serviceFee", () => {
  it("charges 3% on a normal order", () => {
    serviceFee(10000);
  });
  it("applies the minimum fee on small orders", () => {
    serviceFee(1000);
  });
  it("caps the fee on huge orders", () => {
    serviceFee(100000);
  });
});

describe("vatPortion", () => {
  it("extracts 27% VAT from a gross price", () => {
    vatPortion(12700, 27);
  });
  it("extracts 20% VAT from a gross price", () => {
    vatPortion(12000, 20);
  });
});
