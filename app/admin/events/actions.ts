"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelEvent, OrderError } from "@/src/services/orders";
import { getSession } from "@/lib/auth";
import { now } from "@/lib/clock";

export type CancelEventState = { error?: string; done?: { refundedOrders: number; refundedCents: number } };

/** The human half of cancel_event: an admin confirms here, in the UI. */
export async function cancelEventAction(_prev: CancelEventState, form: FormData): Promise<CancelEventState> {
  const session = await getSession();
  if (session?.user.role !== "admin") return { error: "Only admins can cancel events." };
  const eventId = String(form.get("eventId") ?? "");
  if (String(form.get("confirm") ?? "").trim() !== eventId) return { error: "Type the event id exactly to confirm." };
  try {
    const r = await cancelEvent({ db: getDb(), payments: getPayments(), nowMs: await now() }, eventId);
    revalidatePath("/admin/events");
    return { done: { refundedOrders: r.refundedOrders, refundedCents: r.refundedCents } };
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
}
