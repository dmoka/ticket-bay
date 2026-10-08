"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { transferOrderAction, type TransferState } from "./actions";

export function TransferForm({ orderId }: { orderId: number }) {
  const [state, action, pending] = useActionState<TransferState, FormData>(transferOrderAction, {});
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="flex gap-2">
        <Input name="email" type="email" required aria-label="Friend's email" placeholder="friend@example.com" className="w-56" />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Transferring…" : "Transfer"}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
