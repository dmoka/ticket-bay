"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelOrder, OrderError } from "@/src/services/orders";
import { now } from "@/lib/clock";

export type CancelState = { error?: string; refundCents?: number };

export async function cancelOrderAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const orderId = Number(form.get("orderId"));
  try {
    const r = await cancelOrder({ db: getDb(), payments: getPayments(), nowMs: await now() }, orderId);
    revalidatePath(`/orders/${orderId}`);
    return { refundCents: r.refundCents };
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
}
