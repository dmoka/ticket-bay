"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelEventAction, type CancelEventState } from "./actions";

/** The human half of cancel_event: type the event id, then click. */
export function CancelEventForm({ eventId }: { eventId: string }) {
  const [state, action, pending] = useActionState<CancelEventState, FormData>(cancelEventAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="eventId" value={eventId} />
      <div className="space-y-1.5">
        <label htmlFor="confirm" className="block font-medium">
          Type <span className="font-mono">{eventId}</span> to confirm
        </label>
        <Input id="confirm" name="confirm" autoComplete="off" className="max-w-sm font-mono" />
      </div>
      {state.error && (
        <div role="alert" className="max-w-lg rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {state.error}
        </div>
      )}
      <div className="flex gap-2">
        <Button asChild variant="outline">
          <Link href="/admin/events">Keep the event</Link>
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? "Cancelling…" : "Cancel event and refund everyone"}
        </Button>
      </div>
    </form>
  );
}
