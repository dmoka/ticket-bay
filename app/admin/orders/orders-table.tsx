"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpRight } from "lucide-react";
import type { EventRow, OrderRow } from "@/src/db/schema";
import { dateTime, money, orderNumber } from "@/lib/format";
import { Mono, SectionLabel, StatusBadge } from "@/components/app/primitives";
import { InvoiceLines } from "@/components/public/invoice-lines";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type OrderWithEvent = { order: OrderRow; event: EventRow };

const COLUMNS: { key: string; label: string; sort?: string; right?: boolean }[] = [
  { key: "id", label: "Order" },
  { key: "customer", label: "Customer" },
  { key: "event", label: "Event", sort: "event" },
  { key: "created", label: "Placed", sort: "created" },
  { key: "qty", label: "Qty", sort: "quantity", right: true },
  { key: "discount", label: "Discount", right: true },
  { key: "total", label: "Total", sort: "total", right: true },
  { key: "status", label: "Status" },
];

function SortHeader({ col }: { col: (typeof COLUMNS)[number] }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const sort = params.get("sort") ?? "created";
  const dir = params.get("dir") ?? "desc";
  if (!col.sort) return <>{col.label}</>;
  const active = sort === col.sort;
  const next = new URLSearchParams(params.toString());
  next.set("sort", col.sort);
  next.set("dir", active && dir === "desc" ? "asc" : "desc");
  next.delete("peek");
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <Link href={`${pathname}?${next}`} scroll={false} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
      {col.label}
      {active && <Icon className="h-3 w-3" />}
    </Link>
  );
}

function Peek({ row }: { row: OrderWithEvent }) {
  const { order: o, event: e } = row;
  return (
    <>
      <SheetHeader className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <SheetTitle className="font-mono text-base">{orderNumber(o.id)}</SheetTitle>
          <StatusBadge status={o.status} />
        </div>
        <SheetDescription className="text-[12px]">
          Placed <Mono>{dateTime(o.createdAtMs)}</Mono>
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 pt-4 pb-5 text-[13px]">
        <section>
          <SectionLabel className="mb-2">Customer</SectionLabel>
          <div className="font-medium">{o.customerName}</div>
          <div className="text-muted-foreground">{o.customerEmail}</div>
        </section>
        <section>
          <SectionLabel className="mb-2">Event</SectionLabel>
          <div className="font-medium">{e.name}</div>
          <div className="text-muted-foreground">
            <Mono>{dateTime(e.startsAtMs)}</Mono> · {e.venue}
          </div>
        </section>
        <section>
          <SectionLabel className="mb-2">Invoice</SectionLabel>
          <div className="rounded-md border border-border px-3 py-2 text-[13px] [&_*]:text-[13px]">
            <InvoiceLines
              totalLabel="Charged"
              inv={{
                quantity: o.quantity,
                unitCents: Math.round(o.subtotalCents / o.quantity),
                subtotalCents: o.subtotalCents,
                groupPercent: o.groupPercent,
                earlyBirdPercent: o.earlyBirdPercent,
                codePercent: o.codePercent,
                code: o.discountCode,
                discountPercent: o.discountPercent,
                discountCents: o.discountCents,
                ticketsCents: o.ticketsCents,
                feeCents: o.feeCents,
                totalCents: o.totalCents,
                vatCents: o.vatCents,
              }}
            />
          </div>
        </section>
        {o.status === "refunded" && (
          <section>
            <SectionLabel className="mb-2">Refund</SectionLabel>
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Cancelled</dt>
              <dd className="text-right">
                <Mono>{dateTime(o.refundedAtMs ?? 0)}</Mono>
              </dd>
              <dt className="text-muted-foreground">Paid back</dt>
              <dd className="text-right">
                <Mono>{money(o.refundCents ?? 0)}</Mono>
              </dd>
              <dt className="text-muted-foreground">Fee kept</dt>
              <dd className="text-right">
                <Mono>{money(o.refundFeeCents ?? 0)}</Mono>
              </dd>
              <dt className="text-muted-foreground">Seats</dt>
              <dd className="text-right">{o.seatsReleased ? "Released" : "Kept (late)"}</dd>
            </dl>
          </section>
        )}
        <section>
          <SectionLabel className="mb-2">Payment</SectionLabel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Charge</dt>
            <dd className="truncate text-right font-mono text-[12px]">{o.paymentId}</dd>
            {o.refundId && (
              <>
                <dt className="text-muted-foreground">Refund</dt>
                <dd className="truncate text-right font-mono text-[12px]">{o.refundId}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Idempotency key</dt>
            <dd className="truncate text-right font-mono text-[12px]">{o.idempotencyKey}</dd>
          </dl>
        </section>
        <Link href={`/orders/${o.id}`} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          Customer view <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </>
  );
}

export function OrdersTable({ rows, initialPeek }: { rows: OrderWithEvent[]; initialPeek: OrderWithEvent | null }) {
  const [peek, setPeek] = useState<OrderWithEvent | null>(initialPeek);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function close() {
    setPeek(null);
    if (params.get("peek")) {
      const next = new URLSearchParams(params.toString());
      next.delete("peek");
      router.replace(`${pathname}?${next}`, { scroll: false });
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((c, i) => (
              <TableHead
                key={c.key}
                className={cn("h-8 text-[11px] font-normal text-muted-foreground", i === 0 && "px-3", c.right && "text-right", i === COLUMNS.length - 1 && "px-3")}
              >
                <SortHeader col={c} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const o = r.order;
            return (
              <TableRow
                key={o.id}
                onClick={() => setPeek(r)}
                data-state={peek?.order.id === o.id ? "selected" : undefined}
                className="cursor-pointer border-border-subtle text-[13px]"
              >
                <TableCell className="px-3 py-1.5">
                  <Mono>{orderNumber(o.id)}</Mono>
                </TableCell>
                <TableCell className="py-1.5">
                  <div className="leading-tight">{o.customerName}</div>
                  <div className="text-[11px] leading-tight text-muted-foreground">{o.customerEmail}</div>
                </TableCell>
                <TableCell className="max-w-56 truncate py-1.5">{r.event.name}</TableCell>
                <TableCell className="py-1.5">
                  <Mono className="text-muted-foreground">{dateTime(o.createdAtMs)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{o.quantity}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  {o.discountPercent ? <Mono className="text-muted-foreground">−{o.discountPercent}%</Mono> : <span className="text-muted-foreground">—</span>}
                  {o.discountCode && <div className="font-mono text-[10px] text-muted-foreground">{o.discountCode}</div>}
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{money(o.totalCents)}</Mono>
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  <StatusBadge status={o.status} />
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={COLUMNS.length} className="py-10 text-center text-muted-foreground">
                No orders match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Sheet open={peek !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent className="w-[440px] gap-0 sm:max-w-[440px]">{peek && <Peek row={peek} />}</SheetContent>
      </Sheet>
    </>
  );
}
