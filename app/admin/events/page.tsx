import Link from "next/link";
import { getDb } from "@/src/db/client";
import { listEventsAdmin } from "@/src/db/admin-queries";
import { now } from "@/lib/clock";
import { date, money, num, time } from "@/lib/format";
import { CATEGORY_LABEL, eventStatus } from "@/lib/status";
import { Meter, Mono, PageHeader, StatusBadge, Tag } from "@/components/app/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Events" };

export default async function AdminEvents() {
  const nowMs = await now();
  const rows = await listEventsAdmin(getDb());
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
      <div className="surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Event", "Date", "Status", "Price", "Sold", "Capacity", "Sell-through", "Orders", "Refunds", "Revenue"].map((h, i) => (
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
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
