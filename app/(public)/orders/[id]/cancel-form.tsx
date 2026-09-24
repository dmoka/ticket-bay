"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { cancelOrderAction, type CancelState } from "./actions";

export function CancelForm({ orderId }: { orderId: number }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelOrderAction, {});
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel order"}
      </Button>
      {state.error && (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
