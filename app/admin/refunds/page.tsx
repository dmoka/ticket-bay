import Link from "next/link";
import { getDb } from "@/src/db/client";
import { listRefunds } from "@/src/db/admin-queries";
import { dateTime, money, num, orderNumber } from "@/lib/format";
import { Mono, PageHeader } from "@/components/app/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata = { title: "Refunds" };

export default async function AdminRefunds() {
  const rows = listRefunds(getDb());
  const refunded = rows.reduce((s, r) => s + (r.order.refundCents ?? 0), 0);
  const fees = rows.reduce((s, r) => s + (r.order.refundFeeCents ?? 0), 0);
  const late = rows.filter((r) => !r.order.seatsReleased).length;

  const stats = [
    { label: "Refunded orders", value: num(rows.length) },
    { label: "Paid back", value: money(refunded) },
    { label: "Refund fees kept", value: money(fees) },
    { label: "Late cancellations", value: num(late), sub: "after event start — €0 back, seats kept" },
  ];

  return (
    <>
      <PageHeader title="Refunds" description="Every cancellation, the amount the refund module paid back, and what happened to the seats." />
      <div className="surface mb-5 grid grid-cols-4 divide-x divide-border">
        {stats.map((s) => (
          <div key={s.label} className="px-4 py-3">
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
            <Mono className="mt-1 block text-lg font-medium">{s.value}</Mono>
            {s.sub && <div className="text-[11px] text-muted-foreground">{s.sub}</div>}
          </div>
        ))}
      </div>
      <div className="surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Order", "Customer", "Event", "Cancelled", "Tickets", "Paid", "Refunded", "Fee kept", "Seats"].map((h, i) => (
                <TableHead
                  key={h}
                  className={cn("h-8 text-[11px] font-normal text-muted-foreground", i === 0 && "px-3", i >= 4 && i <= 7 && "text-right", i === 8 && "px-3")}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ order: o, event: e }) => (
              <TableRow key={o.id} className="border-border-subtle text-[13px]">
                <TableCell className="px-3 py-1.5">
                  <Link href={`/admin/orders?peek=${o.id}`} className="font-mono hover:underline">
                    {orderNumber(o.id)}
                  </Link>
                </TableCell>
                <TableCell className="py-1.5">
                  {o.customerName}
                  <div className="text-[11px] text-muted-foreground">{o.customerEmail}</div>
                </TableCell>
                <TableCell className="max-w-56 truncate py-1.5">{e.name}</TableCell>
                <TableCell className="py-1.5">
                  <Mono className="text-muted-foreground">{dateTime(o.refundedAtMs ?? 0)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{o.quantity}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono className="text-muted-foreground">{money(o.totalCents)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono className={(o.refundCents ?? 0) === 0 ? "text-negative" : ""}>{money(o.refundCents ?? 0)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono className="text-muted-foreground">{money(o.refundFeeCents ?? 0)}</Mono>
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  {o.seatsReleased ? (
                    <span className="text-[12px]">Released</span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground">Kept (late)</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
