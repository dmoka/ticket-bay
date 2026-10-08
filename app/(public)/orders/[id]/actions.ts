"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelOwnOrder, OrderError } from "@/src/services/orders";
import { transferOrder } from "@/src/services/transfers";
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

export type TransferState = { error?: string };

export async function transferOrderAction(_prev: TransferState, form: FormData): Promise<TransferState> {
  const orderId = Number(form.get("orderId"));
  const session = await getSession();
  if (!session) return { error: "Sign in to transfer this order." };
  try {
    await transferOrder({ db: getDb() }, session.user.id, orderId, String(form.get("email") ?? ""));
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message };
    throw e;
  }
  revalidatePath("/orders");
  redirect("/orders");
}
