"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { OrderError, placeOrder } from "@/src/services/orders";
import { now } from "@/lib/clock";
import { getSession } from "@/lib/auth";

export type CheckoutState = { error?: string };

export async function placeOrderAction(_prev: CheckoutState, form: FormData): Promise<CheckoutState> {
  const field = (k: string) => String(form.get(k) ?? "");
  const session = await getSession();
  if (!session) return { error: "Sign in to book tickets." };
  let orderId: number;
  try {
    const { order } = await placeOrder(
      { db: getDb(), payments: getPayments(), nowMs: await now() },
      {
        eventId: field("eventId"),
        quantity: Number(field("qty")),
        email: session.user.email,
        userId: session.user.id,
        name: field("name"),
        code: field("code"),
        idempotencyKey: field("idempotencyKey"),
      },
    );
    orderId = order.id;
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
  redirect(`/orders/${orderId}?placed=1`);
}
