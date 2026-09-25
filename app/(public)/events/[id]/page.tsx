import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Clock, MapPin, Sparkles } from "lucide-react";
import { getDb } from "@/src/db/client";
import { getEvent } from "@/src/db/events-repo";
import { priceTiers } from "@/src/domain/pricing";
import { EARLY_BIRD_PERCENT, earlyBirdApplies, earlyBirdEndsMs } from "@/src/domain/invoice";
import { now } from "@/lib/clock";
import { date, dateTime, money, num, relativeDays, time } from "@/lib/format";
import { CATEGORY_LABEL, eventStatus } from "@/lib/status";
import { Meter, SectionLabel, StatusBadge, Tag } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const ev = await getEvent(getDb(), (await params).id);
  return { title: ev?.name ?? "Event" };
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ev = await getEvent(getDb(), id);
  if (!ev) notFound();
  const nowMs = await now();
  const status = eventStatus(ev, nowMs);
  const left = Math.max(0, ev.totalSeats - ev.seatsSold);
  const earlyBird = earlyBirdApplies({ startMs: ev.startsAtMs }, nowMs);
  const onSale = status !== "past" && status !== "sold-out" && status !== "cancelled";
  const tiers = priceTiers(ev.priceCents);

  return (
    <div>
      <nav className="mb-6 text-[13px] text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          Events
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">{ev.name}</span>
      </nav>

      <div className="grid grid-cols-1 gap-10 md:grid-cols-[1fr_320px]">
        <div>
          <div className="flex items-center gap-2">
            <Tag>{CATEGORY_LABEL[ev.category]}</Tag>
            <StatusBadge status={status} />
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{ev.name}</h1>
          <dl className="mt-5 grid grid-cols-1 gap-2.5 text-[14px] sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              <span>{date(ev.startsAtMs)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="font-mono tabular-nums">{time(ev.startsAtMs)}</span>
              <span className="text-muted-foreground">· {relativeDays(ev.startsAtMs, nowMs)}</span>
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>
                {ev.venue}, {ev.city}
              </span>
            </div>
          </dl>
          <p className="mt-6 max-w-prose leading-relaxed text-muted-foreground">{ev.description}</p>

          {earlyBird && (
            <div className="mt-8 flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50/60 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/30">
              <Sparkles className="mt-0.5 h-4 w-4 text-blue-600 dark:text-blue-400" />
              <div>
                <div className="font-medium">Early-bird: {EARLY_BIRD_PERCENT}% off every ticket</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  Book before <span className="font-mono tabular-nums">{dateTime(earlyBirdEndsMs({ startMs: ev.startsAtMs }))}</span> — stacks with group discounts.
                </div>
              </div>
            </div>
          )}

          <SectionLabel className="mt-10 mb-3">Price tiers</SectionLabel>
          <div className="surface overflow-hidden">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Tickets</th>
                  <th className="px-4 py-2 font-medium">Group discount</th>
                  <th className="px-4 py-2 text-right font-medium">Per ticket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tiers.map((t) => (
                  <tr key={t.minQty}>
                    <td className="px-4 py-2.5 font-mono tabular-nums">
                      {t.maxQty ? `${t.minQty}–${t.maxQty}` : `${t.minQty}+`}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{t.percent ? `${t.percent}% off` : "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{money(t.unitCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            A service fee of 3% (min {money(100)}, max {money(2000)}) is added at checkout. Prices include 27% VAT.
          </p>
        </div>

        <aside className="md:sticky md:top-20 md:self-start">
          <div className="surface p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-muted-foreground">From</span>
              <span className="font-mono text-2xl font-medium tabular-nums">{money(ev.priceCents)}</span>
            </div>
            <div className="mt-5">
              <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                <span className="text-muted-foreground">Seats left</span>
                <span className="font-mono tabular-nums" data-testid="seats-left">
                  {num(left)} <span className="text-muted-foreground">/ {num(ev.totalSeats)}</span>
                </span>
              </div>
              <Meter value={ev.seatsSold / ev.totalSeats} />
            </div>

            {onSale ? (
              <form action={`/events/${ev.id}/checkout`} method="get" className="mt-6 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="qty">Tickets</Label>
                  <Input id="qty" name="qty" type="number" min={1} defaultValue={2} className="font-mono tabular-nums" />
                </div>
                <Button type="submit" className="w-full">
                  Continue to checkout
                </Button>
              </form>
            ) : (
              <div className="mt-6 rounded-md border border-border bg-muted/50 px-3 py-2.5 text-center text-[13px] text-muted-foreground">
                {status === "past"
                  ? "This event has already taken place."
                  : status === "cancelled"
                    ? "This event has been cancelled. Every ticket holder got a full refund of the ticket price."
                    : "Sold out — no seats left."}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
