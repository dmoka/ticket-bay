"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { retryCancelRefundsAction, type CancelEventState } from "./actions";

export function RetryRefunds({ eventId, pending }: { eventId: string; pending: number }) {
  const [state, action, busy] = useActionState<CancelEventState, FormData>(retryCancelRefundsAction, {});
  return (
    <form action={action} className="mt-2 flex items-center gap-3">
      <input type="hidden" name="eventId" value={eventId} />
      <span className="text-red-700 dark:text-red-400">
        {pending} {pending === 1 ? "refund has" : "refunds have"} not reached the payment provider yet.
      </span>
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        {busy ? "Retrying…" : "Retry refunds"}
      </Button>
      {state.error && <span role="alert" className="text-red-700 dark:text-red-400">{state.error}</span>}
    </form>
  );
}
