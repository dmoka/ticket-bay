import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/src/db/client";
import { cancelImpact } from "@/src/db/admin-queries";
import { getEvent } from "@/src/db/events-repo";
import { now } from "@/lib/clock";
import { requireSession } from "@/lib/auth";
import { date, money, num, time } from "@/lib/format";
import { Mono, PageHeader } from "@/components/app/primitives";
import { CancelEventForm } from "../../cancel-event-form";

export const metadata = { title: "Cancel event" };

/**
 * The event's cancel page — where the cancel_event MCP tool's deep link lands.
 * The agent only ever gets this URL; nothing is cancelled until an admin
 * reads the impact here and confirms.
 */
export default async function CancelEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ via?: string }>;
}) {
  const { id } = await params;
  const { via } = await searchParams;
  // The admin layout already gates /admin; check here too, so this page's
  // numbers never render for anyone else, however the page is requested.
  const session = await requireSession(`/admin/events/${id}/cancel`);
  if (session.user.role !== "admin") notFound();
  const ev = await getEvent(getDb(), id);
  if (!ev) notFound();
  const nowMs = await now();
  const impact = await cancelImpact(getDb(), ev.id);
  const closed = ev.cancelledAtMs !== null ? "This event is already cancelled." : ev.startsAtMs <= nowMs ? "This event has already started — it can no longer be cancelled." : null;

  return (
    <div className="max-w-2xl">
      <nav className="mb-3 text-[12px] text-muted-foreground">
        <Link href="/admin/events" className="hover:text-foreground">
          Events
        </Link>{" "}
        / Cancel
      </nav>
      <PageHeader title={`Cancel ${ev.name}?`} description={`${date(ev.startsAtMs)} ${time(ev.startsAtMs)} · ${ev.venue}, ${ev.city}`} />
      {via === "mcp" && !closed && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30">
          An AI agent prepared this. Nothing has changed yet — you decide.
        </div>
      )}
      {closed ? (
        <div role="status" className="surface p-4">
          {closed}{" "}
          <Link href="/admin/events" className="underline underline-offset-2">
            Back to events
          </Link>
        </div>
      ) : (
        <div className="surface space-y-5 p-5">
          <ul className="space-y-1">
            <li>Ticket sales stop at once</li>
            <li>
              <Mono>{num(impact.orders)}</Mono> paid orders, <Mono>{num(impact.tickets)}</Mono> tickets, are refunded
            </li>
            <li>
              <Mono>{money(impact.refundCents)}</Mono> goes back to customers — the full ticket price, no refund fee
            </li>
          </ul>
          <CancelEventForm eventId={ev.id} />
        </div>
      )}
    </div>
  );
}
