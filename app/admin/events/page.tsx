import Link from "next/link";
import { getDb } from "@/src/db/client";
import { cancelImpact, listEventsAdmin } from "@/src/db/admin-queries";
import { now } from "@/lib/clock";
import { date, money, num, time } from "@/lib/format";
import { CATEGORY_LABEL, eventStatus } from "@/lib/status";
import { Meter, Mono, PageHeader, StatusBadge, Tag } from "@/components/app/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CancelEventDialog } from "./cancel-event-dialog";
import { RetryRefunds } from "./retry-refunds";
import { listUnpaidCancelRefunds } from "@/src/db/orders-repo";

export const metadata = { title: "Events" };

export default async function AdminEvents({ searchParams }: { searchParams: Promise<{ cancel?: string; via?: string }> }) {
  const sp = await searchParams;
  const nowMs = await now();
  const rows = await listEventsAdmin(getDb());
  // Deep link from the cancel_event MCP tool (or the row's Cancel… link).
  const toCancel = rows.find((r) => r.event.id === sp.cancel && r.event.cancelledAtMs === null && r.event.startsAtMs > nowMs)?.event;
  const impact = toCancel ? await cancelImpact(getDb(), toCancel.id) : null;
  const justCancelled = rows.find((r) => r.event.id === sp.cancel && r.event.cancelledAtMs !== null);
  const unpaid = justCancelled ? (await listUnpaidCancelRefunds(getDb(), justCancelled.event.id)).length : 0;
  const capacity = rows.reduce((s, r) => s + r.event.totalSeats, 0);
  const sold = rows.reduce((s, r) => s + r.event.seatsSold, 0);

  return (
    <>
      <PageHeader
        title="Events"
        description={
          <>
            <Mono>{rows.length}</Mono> events · <Mono>{num(sold)}</Mono> of <Mono>{num(capacity)}</Mono> seats sold
          </>
        }
      />
      {justCancelled && (
        <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
          {justCancelled.event.name} is cancelled. Sales are closed and {num(justCancelled.refunds)} orders are refunded, <Mono>{money(justCancelled.refundedCents)}</Mono> in
          total.
          {unpaid > 0 && <RetryRefunds eventId={justCancelled.event.id} pending={unpaid} />}
        </div>
      )}
      {toCancel && impact && (
        <CancelEventDialog
          key={toCancel.id}
          event={{ id: toCancel.id, name: toCancel.name, when: `${date(toCancel.startsAtMs)} ${time(toCancel.startsAtMs)}` }}
          impact={impact}
          fromAgent={sp.via === "mcp"}
        />
      )}
      <div className="surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Event", "Date", "Status", "Price", "Sold", "Capacity", "Sell-through", "Orders", "Refunds", "Revenue", ""].map((h, i) => (
                <TableHead
                  key={h}
                  className={`h-8 text-[11px] font-normal text-muted-foreground ${i === 0 ? "px-3" : ""} ${i >= 3 && i !== 6 ? "text-right" : ""} ${i === 9 ? "px-3" : ""}`}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ event: e, revenueCents, orders, refunds }) => {
              const st = e.seatsSold / e.totalSeats;
              return (
                <TableRow key={e.id} className="border-border-subtle text-[13px]">
                  <TableCell className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <Link href={`/events/${e.id}`} className="font-medium hover:underline">
                        {e.name}
                      </Link>
                      <Tag>{CATEGORY_LABEL[e.category]}</Tag>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {e.venue}, {e.city}
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5">
                    {date(e.startsAtMs)} <Mono className="text-muted-foreground">{time(e.startsAtMs)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5">
                    <StatusBadge status={eventStatus(e, nowMs)} />
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{money(e.priceCents)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{num(e.seatsSold)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono className="text-muted-foreground">{num(e.totalSeats)}</Mono>
                  </TableCell>
                  <TableCell className="w-36 py-1.5">
                    <div className="flex items-center gap-2">
                      <Meter value={st} />
                      <Mono className="w-9 text-right text-[11px] text-muted-foreground">{Math.round(st * 100)}%</Mono>
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono>{num(orders)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Mono className={refunds ? "" : "text-muted-foreground"}>{num(refunds)}</Mono>
                  </TableCell>
                  <TableCell className="px-3 py-1.5 text-right">
                    <Mono>{money(revenueCents)}</Mono>
                  </TableCell>
                  <TableCell className="py-1.5 pr-3 text-right">
                    {e.cancelledAtMs === null && e.startsAtMs > nowMs && (
                      <Link href={`/admin/events?cancel=${e.id}`} className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
                        Cancel…
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
