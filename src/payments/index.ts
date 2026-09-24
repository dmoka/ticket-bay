// A fake, Stripe-shaped payment provider. No network: charges and refunds live
// in memory for the life of the process. It exists so the checkout has a real
// seam — a secret key, idempotency keys, failures — without a real processor.
import { randomBytes } from "node:crypto";

export interface ChargeInput {
  amountCents: number;
  currency: "eur";
  /** Same key + same amount returns the original charge instead of charging twice. */
  idempotencyKey: string;
  description: string;
}

export interface Charge {
  id: string;
  amountCents: number;
  currency: string;
  description: string;
  idempotencyKey: string;
  refundedCents: number;
  createdAtMs: number;
}

export interface Refund {
  id: string;
  chargeId: string;
  amountCents: number;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_key" | "invalid_amount" | "idempotency_conflict" | "no_such_charge" | "refund_exceeds_charge",
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface PaymentProvider {
  charge(input: ChargeInput): Promise<Charge>;
  refund(chargeId: string, amountCents: number, idempotencyKey: string): Promise<Refund>;
  getCharge(chargeId: string): Charge | undefined;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

export function createFakeStripe(secretKey: string | undefined): PaymentProvider {
  if (!secretKey) throw new PaymentError("STRIPE_SECRET_KEY is not set", "invalid_key");
  if (secretKey.startsWith("sk_live_")) {
    throw new PaymentError("the fake provider refuses live keys — use an sk_test_ key", "invalid_key");
  }
  if (!secretKey.startsWith("sk_test_")) throw new PaymentError("STRIPE_SECRET_KEY must start with sk_test_", "invalid_key");

  const charges = new Map<string, Charge>();
  const byChargeKey = new Map<string, Charge>();
  const refundsByKey = new Map<string, Refund>();

  return {
    async charge(input) {
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
        throw new PaymentError("amount must be a positive whole number of cents", "invalid_amount");
      }
      const seen = byChargeKey.get(input.idempotencyKey);
      if (seen) {
        if (seen.amountCents !== input.amountCents) {
          throw new PaymentError("idempotency key reused with a different amount", "idempotency_conflict");
        }
        return seen;
      }
      const charge: Charge = {
        id: id("ch"),
        amountCents: input.amountCents,
        currency: input.currency,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        refundedCents: 0,
        createdAtMs: Date.now(),
      };
      charges.set(charge.id, charge);
      byChargeKey.set(input.idempotencyKey, charge);
      return charge;
    },

    async refund(chargeId, amountCents, idempotencyKey) {
      const seen = refundsByKey.get(idempotencyKey);
      if (seen) return seen;
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new PaymentError("refund must be a positive whole number of cents", "invalid_amount");
      }
      const charge = charges.get(chargeId);
      // Charges made by an earlier process (seed data, a restart) are not in
      // memory. A real provider would know them; the fake accepts the refund.
      if (charge) {
        if (charge.refundedCents + amountCents > charge.amountCents) {
          throw new PaymentError("refund exceeds the amount charged", "refund_exceeds_charge");
        }
        charge.refundedCents += amountCents;
      }
      const refund: Refund = { id: id("re"), chargeId, amountCents };
      refundsByKey.set(idempotencyKey, refund);
      return refund;
    },

    getCharge: (chargeId) => charges.get(chargeId),
  };
}

/** Local-dev fallback so a fresh clone works before anyone creates a .env. */
export const FALLBACK_TEST_KEY = "sk_test_ticketbay_local_fallback";

const globalForPayments = globalThis as unknown as { __ticketbayPayments?: PaymentProvider };

/** The app's provider, configured from STRIPE_SECRET_KEY (see .env.example). */
export function getPayments(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  if (!globalForPayments.__ticketbayPayments) {
    globalForPayments.__ticketbayPayments = createFakeStripe(env.STRIPE_SECRET_KEY || FALLBACK_TEST_KEY);
  }
  return globalForPayments.__ticketbayPayments;
}
