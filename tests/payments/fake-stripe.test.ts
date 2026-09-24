import { describe, it, expect } from "vitest";
import { createFakeStripe, PaymentError } from "../../src/payments";

const KEY = "sk_test_unit";
const input = (over = {}) => ({ amountCents: 10_300, currency: "eur" as const, idempotencyKey: "k1", description: "2 x Show", ...over });

describe("the fake payment provider", () => {
  it("refuses to start without a key, with a live key, or with a non-test key", () => {
    expect(() => createFakeStripe(undefined)).toThrow(PaymentError);
    expect(() => createFakeStripe("sk_live_abc")).toThrow(/live keys/);
    expect(() => createFakeStripe("pk_test_abc")).toThrow(PaymentError);
  });

  it("charges a positive whole number of cents", async () => {
    const p = createFakeStripe(KEY);
    const c = await p.charge(input());
    expect(c.id).toMatch(/^ch_/);
    expect(c.amountCents).toBe(10_300);
    await expect(p.charge(input({ idempotencyKey: "k2", amountCents: 0 }))).rejects.toThrow(PaymentError);
    await expect(p.charge(input({ idempotencyKey: "k3", amountCents: 12.5 }))).rejects.toThrow(PaymentError);
  });

  it("returns the original charge when the same idempotency key is replayed", async () => {
    const p = createFakeStripe(KEY);
    const a = await p.charge(input());
    const b = await p.charge(input());
    expect(b.id).toBe(a.id);
  });

  it("refuses an idempotency key reused for a different amount", async () => {
    const p = createFakeStripe(KEY);
    await p.charge(input());
    await expect(p.charge(input({ amountCents: 1 }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("never refunds more than was charged, across several refunds", async () => {
    const p = createFakeStripe(KEY);
    const c = await p.charge(input());
    await p.refund(c.id, 10_000, "r1");
    await expect(p.refund(c.id, 301, "r2")).rejects.toMatchObject({ code: "refund_exceeds_charge" });
    await p.refund(c.id, 300, "r3");
    expect(p.getCharge(c.id)?.refundedCents).toBe(10_300);
  });

  it("treats a replayed refund key as the same refund, not a second payout", async () => {
    const p = createFakeStripe(KEY);
    const c = await p.charge(input());
    const a = await p.refund(c.id, 9_800, "refund-1");
    const b = await p.refund(c.id, 9_800, "refund-1");
    expect(b.id).toBe(a.id);
    expect(p.getCharge(c.id)?.refundedCents).toBe(9_800);
  });
});
