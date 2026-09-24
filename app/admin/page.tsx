import Link from "next/link";
import { getDb } from "@/src/db/client";
import { getOverview } from "@/src/db/admin-queries";
import { now } from "@/lib/clock";
import { dayMonth, money, moneyShort, num, orderNumber, time } from "@/lib/format";
import { eventStatus } from "@/lib/status";
import { Meter, Mono, PageHeader, SectionLabel, StatusBadge } from "@/components/app/primitives";
import { Delta } from "@/components/admin/delta";
import { RevenueChart } from "@/components/admin/revenue-chart";
import { Sparkline } from "@/components/admin/sparkline";
import { parseTimeframe, TimeframeSelector } from "@/components/admin/timeframe";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Overview" };

export default async function AdminOverview({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const days = parseTimeframe((await searchParams).t);
  const nowMs = await now();
  const o = getOverview(getDb(), nowMs, days);

  const kpis = [
    { label: "Revenue", value: moneyShort(o.revenue.cur), kpi: o.revenue, delta: <Delta cur={o.revenue.cur} prev={o.revenue.prev} /> },
    { label: "Tickets sold", value: num(o.tickets.cur), kpi: o.tickets, delta: <Delta cur={o.tickets.cur} prev={o.tickets.prev} /> },
    {
      label: "Refunds",
      value: moneyShort(o.refunds.cur),
      sub: `${o.refunds.count} orders`,
      kpi: o.refunds,
      delta: <Delta cur={o.refunds.cur} prev={o.refunds.prev} invert />,
    },
    {
      label: "Sell-through",
      value: `${(o.sellThrough.cur / 100).toFixed(1)}%`,
      sub: "of all capacity",
      kpi: o.sellThrough,
      delta: <Delta cur={o.sellThrough.cur} prev={o.sellThrough.prev} points />,
    },
  ];

  return (
    <>
      <PageHeader title="Overview" description={`Last ${days} days vs the ${days} days before`}>
        <TimeframeSelector days={days} basePath="/admin" />
      </PageHeader>

      <div className="surface mb-5 grid grid-cols-2 divide-border max-lg:gap-y-px lg:grid-cols-4 lg:divide-x" data-testid="kpi-strip">
        {kpis.map((k) => (
          <div key={k.label} className="px-4 pt-3 pb-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{k.label}</span>
              {k.sub && <span className="font-mono">{k.sub}</span>}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <Mono className="text-xl font-medium tracking-tight">{k.value}</Mono>
              {k.delta}
            </div>
            <Sparkline values={k.kpi.series} className="mt-2 h-7 w-full" />
          </div>
        ))}
      </div>

      <div className="surface mb-5 px-4 pt-3 pb-2">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Revenue · daily</SectionLabel>
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded bg-chart-1" /> Last {days}d
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded border-t border-dashed border-chart-2" /> Previous {days}d
            </span>
          </div>
        </div>
        <RevenueChart
          data={o.daily.map((d) => ({ label: dayMonth(d.dayStartMs), revenueCents: d.revenueCents, prevRevenueCents: d.prevRevenueCents }))}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <div className="surface xl:col-span-3">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <SectionLabel>Top events · last {days}d</SectionLabel>
            <Link href="/admin/events" className="text-[11px] text-muted-foreground hover:text-foreground">
              All events →
            </Link>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8 px-3 font-normal text-muted-foreground">Event</TableHead>
                <TableHead className="h-8 font-normal text-muted-foreground">Status</TableHead>
                <TableHead className="h-8 text-right font-normal text-muted-foreground">Orders</TableHead>
                <TableHead className="h-8 text-right font-normal text-muted-foreground">Tickets</TableHead>
                <TableHead className="h-8 text-right font-normal text-muted-foreground">Revenue</TableHead>
                <TableHead className="h-8 w-28 px-3 font-normal text-muted-foreground">Sold</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.topEvents.map((p) => (
                <TableRow key={p.event.id} className="border-border-subtle text-[13px]">
                  <TableCell className="px-3 py-1.5 font-medium">{p.event.name}</TableCell>
                  <TableCell className="py-1.5">
                    <StatusBadge status={eventStatus(p.event, nowMs)} />
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{num(p.orders)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{num(p.tickets)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{money(p.revenueCents)}</Mono>
                  </TableCell>
                  <TableCell className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <Meter value={p.event.seatsSold / p.event.totalSeats} />
                      <Mono className="w-9 text-right text-[11px] text-muted-foreground">
                        {Math.round((p.event.seatsSold / p.event.totalSeats) * 100)}%
                      </Mono>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {o.topEvents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No sales in this period.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="surface xl:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <SectionLabel>Latest orders</SectionLabel>
            <Link href="/admin/orders" className="text-[11px] text-muted-foreground hover:text-foreground">
              All orders →
            </Link>
          </div>
          <Table>
            <TableBody>
              {o.recent.map(({ order, event }) => (
                <TableRow key={order.id} className="border-border-subtle text-[13px]">
                  <TableCell className="px-3 py-1.5">
                    <Link href={`/admin/orders?peek=${order.id}`} className="font-mono hover:underline">
                      {orderNumber(order.id)}
                    </Link>
                    <div className="max-w-40 truncate text-[11px] text-muted-foreground">{event.name}</div>
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                    <Mono>
                      {dayMonth(order.createdAtMs)} {time(order.createdAtMs)}
                    </Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{money(order.totalCents)}</Mono>
                  </TableCell>
                  <TableCell className="px-3 py-1.5 text-right">
                    <StatusBadge status={order.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
