"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelOwnOrder, OrderError } from "@/src/services/orders";
import { now } from "@/lib/clock";
import { getSession } from "@/lib/auth";

export type CancelState = { error?: string; refundCents?: number };

export async function cancelOrderAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const orderId = Number(form.get("orderId"));
  const session = await getSession();
  if (!session) return { error: "Sign in to cancel this order." };
  try {
    const r = await cancelOwnOrder({ db: getDb(), payments: getPayments(), nowMs: await now() }, session.user.id, orderId);
    revalidatePath(`/orders/${orderId}`);
    return { refundCents: r.refundCents };
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
}
