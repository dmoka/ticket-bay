"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { OrderError, placeOrder } from "@/src/services/orders";
import { now } from "@/lib/clock";

export type CheckoutState = { error?: string };

export async function placeOrderAction(_prev: CheckoutState, form: FormData): Promise<CheckoutState> {
  const field = (k: string) => String(form.get(k) ?? "");
  let orderId: number;
  try {
    const { order } = await placeOrder(
      { db: getDb(), payments: getPayments(), nowMs: await now() },
      {
        eventId: field("eventId"),
        quantity: Number(field("qty")),
        email: field("email"),
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
  // Demo identity: "My orders" finds orders by the last email used here.
  (await cookies()).set("tb-email", field("email").trim().toLowerCase(), { path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect(`/orders/${orderId}?placed=1`);
}
