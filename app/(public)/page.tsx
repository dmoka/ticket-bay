import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { listEvents } from "@/src/db/events-repo";
import { getDb } from "@/src/db/client";
import type { EventRow } from "@/src/db/schema";
import { now } from "@/lib/clock";
import { dayOfMonth, monthShort, money, num, time, date } from "@/lib/format";
import { CATEGORY_LABEL, eventStatus } from "@/lib/status";
import { StatusBadge, Tag } from "@/components/app/primitives";
import { cn } from "@/lib/utils";

function EventRowItem({ ev, nowMs }: { ev: EventRow; nowMs: number }) {
  const status = eventStatus(ev, nowMs);
  const left = ev.totalSeats - ev.seatsSold;
  const past = status === "past";
  return (
    <li>
      <Link
        href={`/events/${ev.id}`}
        className={cn(
          "group grid grid-cols-[56px_1fr_auto] items-center gap-5 px-5 py-4 transition-colors hover:bg-subtle",
          past && "opacity-60",
        )}
      >
        <div className="flex h-14 w-14 flex-col items-center justify-center rounded-md border border-border">
          <span className="text-[10px] font-medium tracking-wider text-muted-foreground">{monthShort(ev.startsAtMs)}</span>
          <span className="font-mono text-lg leading-none font-medium tabular-nums">{dayOfMonth(ev.startsAtMs)}</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-medium">{ev.name}</h2>
            <StatusBadge status={status} />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            <Tag>{CATEGORY_LABEL[ev.category]}</Tag>
            <span>
              {ev.venue}, {ev.city}
            </span>
            <span className="text-border">·</span>
            <span className="font-mono tabular-nums">{time(ev.startsAtMs)}</span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono text-[15px] font-medium tabular-nums">{money(ev.priceCents)}</div>
            <div className="mt-0.5 font-mono text-[12px] text-muted-foreground tabular-nums">
              {past ? date(ev.startsAtMs) : left > 0 ? `${num(left)} seats left` : "0 seats left"}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </Link>
    </li>
  );
}

export default async function EventsPage() {
  const nowMs = await now();
  const all = await listEvents(getDb());
  const upcoming = all.filter((e) => e.startsAtMs > nowMs);
  const past = all.filter((e) => e.startsAtMs <= nowMs).reverse();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Upcoming events</h1>
        <p className="mt-1.5 text-muted-foreground">
          Concerts, festivals, conferences and comedy. Book 30+ days ahead for the early-bird price; groups of 5+ save up to 10%.
        </p>
      </div>

      <ul className="surface divide-y divide-border overflow-hidden">
        {upcoming.map((ev) => (
          <EventRowItem key={ev.id} ev={ev} nowMs={nowMs} />
        ))}
        {upcoming.length === 0 && <li className="px-5 py-10 text-center text-muted-foreground">No upcoming events.</li>}
      </ul>

      {past.length > 0 && (
        <>
          <h2 className="mt-12 mb-3 text-[13px] font-medium text-muted-foreground">Past events</h2>
          <ul className="surface divide-y divide-border overflow-hidden">
            {past.map((ev) => (
              <EventRowItem key={ev.id} ev={ev} nowMs={nowMs} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
