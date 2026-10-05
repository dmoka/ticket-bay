import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { getDb } from "@/src/db/client";
import { getOrderWithEvent, isOrderId, toDomainOrder } from "@/src/db/orders-repo";
import { listRefundsForOrder } from "@/src/db/refunds-repo";
import { quoteCancellation, refundsSoFar } from "@/src/domain/cancellation";
import { now } from "@/lib/clock";
import { requireSession } from "@/lib/auth";
import { date, dateTime, money, orderNumber, time } from "@/lib/format";
import { SectionLabel, StatusBadge } from "@/components/app/primitives";
import { InvoiceLines } from "@/components/public/invoice-lines";
import { CancelForm } from "./cancel-form";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `Order ${orderNumber(Number((await params).id))}` };
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const id = Number((await params).id);
  const { placed } = await searchParams;
  const session = await requireSession(`/orders/${(await params).id}`);
  const found = isOrderId(id) ? await getOrderWithEvent(getDb(), id) : undefined;
  // Someone else's order is simply not found: an order number leaks nothing.
  if (!found || found.order.userId !== session.user.id) notFound();
  const { order, event: ev } = found;
  const nowMs = await now();
  const refunds = await listRefundsForOrder(getDb(), order.id);
  const soFar = refundsSoFar(refunds);
  const ticketsLeft = order.quantity - soFar.ticketsCancelled;
  // What cancelling every ticket left pays right now: the same domain function the cancel uses.
  const quote = order.status === "paid" && ticketsLeft > 0 ? quoteCancellation(toDomainOrder(order, ev), soFar, ticketsLeft, nowMs) : null;

  return (
    <div className="mx-auto max-w-3xl">
      {placed && order.status === "paid" && (
        <div className="mb-8 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div>
            <div className="font-medium">Payment confirmed — you&apos;re going to {ev.name}.</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {order.quantity} {order.quantity === 1 ? "ticket" : "tickets"} for {order.customerName}. Find this order any time under My orders.
            </div>
          </div>
        </div>
      )}

      <nav className="mb-6 text-[13px] text-muted-foreground">
        <Link href="/orders" className="hover:text-foreground">
          My orders
        </Link>
        <span className="mx-1.5">/</span>
        <span className="font-mono text-foreground">{orderNumber(order.id)}</span>
      </nav>

      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{orderNumber(order.id)}</h1>
            <StatusBadge status={order.status} />
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Placed <span className="font-mono tabular-nums">{dateTime(order.createdAtMs)}</span> by {order.customerName}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[12px] text-muted-foreground">Total paid</div>
          <div className="font-mono text-2xl font-medium tabular-nums" data-testid="paid-amount">
            {money(order.totalCents)}
          </div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-[1fr_1fr]">
        <section>
          <SectionLabel className="mb-3">Event</SectionLabel>
          <Link href={`/events/${ev.id}`} className="surface block p-5 transition-colors hover:bg-subtle">
            <div className="font-medium">{ev.name}</div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              {date(ev.startsAtMs)} · <span className="font-mono tabular-nums">{time(ev.startsAtMs)}</span>
            </div>
            <div className="text-[13px] text-muted-foreground">
              {ev.venue}, {ev.city}
            </div>
            <div className="mt-4 flex items-baseline justify-between text-[13px]">
              <span className="text-muted-foreground">Tickets</span>
              <span className="font-mono tabular-nums">
                {order.quantity}
                {soFar.ticketsCancelled > 0 && <span className="text-muted-foreground"> · {soFar.ticketsCancelled} cancelled</span>}
              </span>
            </div>
          </Link>

          <SectionLabel className="mt-6 mb-3">Payment</SectionLabel>
          <div className="surface space-y-1.5 p-5 text-[13px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Charge</span>
              <span className="font-mono">{order.paymentId.slice(0, 20)}…</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Card</span>
              <span className="font-mono">•••• 4242</span>
            </div>
          </div>
        </section>

        <section>
          <SectionLabel className="mb-3">Invoice</SectionLabel>
          <div className="surface p-5">
            <InvoiceLines
              totalLabel="Total paid"
              inv={{
                quantity: order.quantity,
                unitCents: Math.round(order.subtotalCents / order.quantity),
                subtotalCents: order.subtotalCents,
                groupPercent: order.groupPercent,
                earlyBirdPercent: order.earlyBirdPercent,
                codePercent: order.codePercent,
                code: order.discountCode,
                discountPercent: order.discountPercent,
                discountCents: order.discountCents,
                ticketsCents: order.ticketsCents,
                feeCents: order.feeCents,
                totalCents: order.totalCents,
                vatCents: order.vatCents,
              }}
            />
          </div>
        </section>
      </div>

      <section className="mt-8">
        <SectionLabel className="mb-3">Cancellation</SectionLabel>
        <div className="surface divide-y divide-border">
          {refunds.length > 0 && (
            <div className="space-y-1.5 p-5 text-[14px]">
              <p className="flex items-baseline justify-between font-medium" data-testid="refund-line">
                <span>Refunded</span>{" "}
                <span className="font-mono tabular-nums" data-testid="refund-amount">
                  {money(soFar.grossCents - soFar.feeCents)}
                </span>
              </p>
              <p className="flex items-baseline justify-between text-[13px] text-muted-foreground">
                <span>Refund fee kept</span>
                <span className="font-mono tabular-nums">{money(soFar.feeCents)}</span>
              </p>
              {refunds.length === 1 && refunds[0].tickets === order.quantity ? (
                <p className="pt-1 text-[13px] text-muted-foreground">
                  Cancelled <span className="font-mono tabular-nums">{dateTime(refunds[0].createdAtMs)}</span>.{" "}
                  {refunds[0].seatsReleased
                    ? "The seats went back on sale."
                    : "Cancelled after the event started — no refund, and the seats stay yours."}
                </p>
              ) : (
                <ul className="space-y-1 pt-1 text-[13px] text-muted-foreground" data-testid="refund-list">
                  {refunds.map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-4">
                      <span>
                        <span className="font-mono tabular-nums">{dateTime(r.createdAtMs)}</span> · {r.tickets} {r.tickets === 1 ? "ticket" : "tickets"}
                        {r.reason === "event_cancelled" && " · the event was cancelled, no fee"}
                        {!r.seatsReleased && " · after the event started — no refund, and the seats stay yours"}
                      </span>
                      <span className="font-mono tabular-nums">
                        {money(r.netCents)}
                        {r.feeCents > 0 && <span> (fee {money(r.feeCents)})</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {quote && (
            <div className="p-5">
              <CancelForm
                key={ticketsLeft}
                orderId={order.id}
                idempotencyKey={randomUUID()}
                ticketsLeft={ticketsLeft}
                wholeOrder={soFar.ticketsCancelled === 0}
                initial={{ tickets: quote.tickets, windowOpen: quote.windowOpen, grossCents: quote.grossCents, feeCents: quote.feeCents, netCents: quote.netCents }}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
