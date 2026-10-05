"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money } from "@/lib/format";
import { cancelOrderAction, quoteCancelAction, type CancelPreview, type CancelState, type QuoteState } from "./actions";

const ticketsWord = (n: number) => (n === 1 ? "ticket" : "tickets");

/** What the cancel would pay right now, in words. */
function Preview({ quote }: { quote: CancelPreview }) {
  if (!quote.windowOpen) {
    return (
      <p>
        <span className="font-medium">The refund window has closed.</span>{" "}
        <span className="text-muted-foreground">
          Refunds close when the event starts. Cancelling now refunds <span className="font-mono tabular-nums">{money(0)}</span> and the seats stay yours.
        </span>
      </p>
    );
  }
  return (
    <p>
      Cancel {quote.tickets} {ticketsWord(quote.tickets)} now and get{" "}
      <span className="font-mono font-medium tabular-nums" data-testid="refund-preview-amount">
        {money(quote.netCents)}
      </span>{" "}
      back
      <span className="text-muted-foreground">
        {" "}
        — <span className="font-mono tabular-nums">{money(quote.grossCents)}</span> for the {ticketsWord(quote.tickets)} less a{" "}
        <span className="font-mono tabular-nums">{money(quote.feeCents)}</span> refund fee. The service fee is not refundable.
      </span>
    </p>
  );
}

/**
 * Cancel some or all of the tickets left on an order. The preview is the
 * server's quote for the count in the box, refreshed as it changes.
 */
export function CancelForm({
  orderId,
  ticketsLeft,
  wholeOrder,
  initial,
  idempotencyKey,
}: {
  orderId: number;
  /** one per rendered form — a double submit must not cancel twice */
  idempotencyKey: string;
  ticketsLeft: number;
  /** nothing cancelled yet: cancelling every ticket left cancels the order */
  wholeOrder: boolean;
  /** the quote for every ticket left, priced by the page */
  initial: CancelPreview;
}) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelOrderAction, {});
  const [tickets, setTickets] = useState(String(ticketsLeft));
  const [preview, setPreview] = useState<QuoteState>({ quote: initial });
  const [quoting, startQuote] = useTransition();
  // Only the answer to the latest count may land: an older, slower one is dropped.
  const latest = useRef(0);

  function onTickets(value: string) {
    setTickets(value);
    const asked = ++latest.current;
    startQuote(async () => {
      const q = await quoteCancelAction(orderId, value);
      if (asked === latest.current) setPreview(q);
    });
  }

  const n = Number(tickets);
  const label =
    !Number.isInteger(n) || n < 1 || n > ticketsLeft
      ? "Cancel tickets"
      : n === ticketsLeft
        ? wholeOrder
          ? "Cancel order"
          : `Cancel the ${ticketsLeft} ${ticketsWord(ticketsLeft)} left`
        : `Cancel ${n} ${ticketsWord(n)}`;

  return (
    <form action={action} className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-6">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="flex-1 space-y-3 text-[13px]">
        {ticketsLeft > 1 && initial.windowOpen && (
          <div className="flex items-center gap-3">
            <Label htmlFor="cancel-tickets" className="text-[13px]">
              Tickets to cancel
            </Label>
            <Input
              id="cancel-tickets"
              name="tickets"
              type="number"
              inputMode="numeric"
              min={1}
              max={ticketsLeft}
              step={1}
              value={tickets}
              onChange={(e) => onTickets(e.target.value)}
              className="w-20 font-mono tabular-nums"
            />
            <span className="text-muted-foreground">of {ticketsLeft} left</span>
          </div>
        )}
        <div data-testid="refund-preview" aria-live="polite" aria-busy={quoting} className={quoting ? "opacity-60" : undefined}>
          {preview.error ? (
            <p className="text-red-600 dark:text-red-400">{preview.error}</p>
          ) : (
            preview.quote && <Preview quote={preview.quote} />
          )}
        </div>
      </div>
      <div className="flex flex-col items-start gap-2">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Cancelling…" : label}
        </Button>
        {state.error && (
          <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
