"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db/client";
import { getPayments, PaymentError } from "@/src/payments";
import { cancelOwnOrder, OrderError, quoteOwnCancel } from "@/src/services/orders";
import { now } from "@/lib/clock";
import { getSession } from "@/lib/auth";

export type CancelState = { error?: string; refundCents?: number };

/** The form's ticket count: empty means every ticket left. Anything else goes to the service to judge. */
function ticketsFrom(raw: FormDataEntryValue | null): number | undefined {
  return raw === null || String(raw).trim() === "" ? undefined : Number(raw);
}

export async function cancelOrderAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const orderId = Number(form.get("orderId"));
  const session = await getSession();
  if (!session) return { error: "Sign in to cancel this order." };
  // One per rendered form: a double submit cancels once.
  const key = String(form.get("idempotencyKey") ?? "").trim();
  if (!key || key.length > 100) return { error: "This page is out of date. Reload it and try again." };
  try {
    const r = await cancelOwnOrder(
      { db: getDb(), payments: getPayments(), nowMs: await now() },
      session.user.id,
      orderId,
      ticketsFrom(form.get("tickets")),
      `web:${session.user.id}:${key}`,
    );
    revalidatePath(`/orders/${orderId}`);
    return { refundCents: r.refundCents };
  } catch (e) {
    if (e instanceof OrderError || e instanceof PaymentError) return { error: e.message };
    throw e;
  }
}

export interface CancelPreview {
  tickets: number;
  windowOpen: boolean;
  grossCents: number;
  feeCents: number;
  netCents: number;
}

export type QuoteState = { error?: string; quote?: CancelPreview };

/**
 * The cancel form's live preview: what cancelling `tickets` pays right now,
 * from the same service and domain function the cancel itself uses.
 */
export async function quoteCancelAction(orderId: number, tickets: string): Promise<QuoteState> {
  const session = await getSession();
  if (!session) return { error: "Sign in to cancel this order." };
  try {
    const q = await quoteOwnCancel({ db: getDb(), nowMs: await now() }, session.user.id, orderId, ticketsFrom(tickets));
    return { quote: { tickets: q.tickets, windowOpen: q.windowOpen, grossCents: q.grossCents, feeCents: q.feeCents, netCents: q.netCents } };
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message };
    throw e;
  }
}
