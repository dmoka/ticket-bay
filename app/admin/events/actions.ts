"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelEvent, OrderError } from "@/src/services/orders";
import { getSession } from "@/lib/auth";
import { now } from "@/lib/clock";

export type CancelEventState = { error?: string };

/** The human half of cancel_event: an admin confirms here, in the UI. */
export async function cancelEventAction(_prev: CancelEventState, form: FormData): Promise<CancelEventState> {
  const session = await getSession();
  if (session?.user.role !== "admin") return { error: "Only admins can cancel events." };
  const eventId = String(form.get("eventId") ?? "");
  if (String(form.get("confirm") ?? "").trim() !== eventId) return { error: "Type the event id exactly to confirm." };
  try {
    await cancelEvent({ db: getDb(), payments: getPayments(), nowMs: await now() }, eventId);
    revalidatePath("/admin/events");
    return {};
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
}

/** Retry the payouts a cancellation still owes (a provider failure mid-way). */
export async function retryCancelRefundsAction(_prev: CancelEventState, form: FormData): Promise<CancelEventState> {
  const session = await getSession();
  if (session?.user.role !== "admin") return { error: "Only admins can retry refunds." };
  try {
    await cancelEvent({ db: getDb(), payments: getPayments(), nowMs: await now() }, String(form.get("eventId") ?? ""));
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  } finally {
    revalidatePath("/admin/events");
  }
  return {};
}
