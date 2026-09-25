"use client";

import { useActionState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { placeOrderAction, type CheckoutState } from "./actions";

export function CheckoutForm({
  eventId,
  qty,
  code,
  idempotencyKey,
  payLabel,
  disabled,
  email,
  defaultName,
}: {
  eventId: string;
  qty: number;
  code: string;
  idempotencyKey: string;
  payLabel: string;
  disabled: boolean;
  email: string;
  defaultName: string;
}) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(placeOrderAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="qty" value={qty} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} readOnly className="bg-muted/40 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">Tickets go to your account email.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="name">Name on tickets</Label>
        <Input id="name" name="name" required autoComplete="name" defaultValue={defaultName} placeholder="Anna Kovács" />
      </div>
      <div className="space-y-1.5">
        <Label>Card</Label>
        <div className="flex h-9 items-center justify-between rounded-md border border-input bg-muted/40 px-3 text-[13px] text-muted-foreground">
          <span className="font-mono tabular-nums">4242 4242 4242 4242</span>
          <span className="font-mono tabular-nums">12/34 · 123</span>
        </div>
        <p className="text-[12px] text-muted-foreground">Test mode — the fake provider charges nothing real.</p>
      </div>
      {state.error && (
        <div role="alert" data-testid="checkout-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {state.error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={disabled || pending}>
        <Lock className="h-3.5 w-3.5" />
        {pending ? "Processing…" : payLabel}
      </Button>
    </form>
  );
}
