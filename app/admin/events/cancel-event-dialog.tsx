"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { money, num } from "@/lib/format";
import { cancelEventAction, type CancelEventState } from "./actions";

export function CancelEventDialog({
  event,
  impact,
  fromAgent,
}: {
  event: { id: string; name: string; when: string };
  impact: { orders: number; tickets: number; refundCents: number };
  fromAgent: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [state, action, pending] = useActionState<CancelEventState, FormData>(cancelEventAction, {});
  const close = () => {
    setOpen(false);
    router.replace("/admin/events");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="text-[13px]">
        <DialogHeader>
          <DialogTitle>Cancel {event.name}?</DialogTitle>
          <DialogDescription>
            {event.when}. {fromAgent && "An AI agent prepared this. Nothing has changed yet — you decide."}
          </DialogDescription>
        </DialogHeader>
        {state.done ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30" role="status">
            Event cancelled. {num(state.done.refundedOrders)} orders refunded, <span className="font-mono">{money(state.done.refundedCents)}</span> in total.
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="eventId" value={event.id} />
            <ul className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2">
              <li>
                Ticket sales stop <span className="text-muted-foreground">at once</span>
              </li>
              <li>
                <span className="font-mono">{num(impact.orders)}</span> paid orders, <span className="font-mono">{num(impact.tickets)}</span> tickets, are refunded
              </li>
              <li>
                <span className="font-mono">{money(impact.refundCents)}</span> goes back to customers — the full ticket price, no refund fee
              </li>
            </ul>
            <div className="space-y-1.5">
              <label htmlFor="confirm" className="block font-medium">
                Type <span className="font-mono">{event.id}</span> to confirm
              </label>
              <Input id="confirm" name="confirm" autoComplete="off" className="font-mono" />
            </div>
            {state.error && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                {state.error}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Keep the event
              </Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Cancelling…" : "Cancel event and refund everyone"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
