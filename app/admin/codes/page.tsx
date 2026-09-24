import { getDb } from "@/src/db/client";
import { listCodesAdmin } from "@/src/db/admin-queries";
import { codeStatus } from "@/src/domain/pricing";
import { toDomainCode } from "@/src/db/codes-repo";
import { now } from "@/lib/clock";
import { date, money, num } from "@/lib/format";
import { Meter, Mono, PageHeader, StatusBadge } from "@/components/app/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata = { title: "Discount codes" };

export default async function AdminCodes() {
  const nowMs = await now();
  const rows = listCodesAdmin(getDb());
  return (
    <>
      <PageHeader title="Discount codes" description="Codes stack with group and early-bird discounts; the combined discount is capped at 100%." />
      <div className="surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Code", "Discount", "Status", "Uses", "Limit", "Expires", "Orders", "Discount given", "Revenue"].map((h, i) => (
                <TableHead
                  key={h}
                  className={cn("h-8 text-[11px] font-normal text-muted-foreground", i === 0 && "px-3", [1, 6, 7, 8].includes(i) && "text-right", i === 8 && "px-3")}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ code: c, orders, discountCents, revenueCents }) => (
              <TableRow key={c.code} className="border-border-subtle text-[13px]">
                <TableCell className="px-3 py-1.5">
                  <Mono className="font-medium">{c.code}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{c.percent}%</Mono>
                </TableCell>
                <TableCell className="py-1.5">
                  <StatusBadge status={codeStatus(toDomainCode(c), nowMs)} />
                </TableCell>
                <TableCell className="w-40 py-1.5">
                  <div className="flex items-center gap-2">
                    <Mono className="w-6">{num(c.uses)}</Mono>
                    {c.maxUses !== null && <Meter value={c.uses / c.maxUses} />}
                  </div>
                </TableCell>
                <TableCell className="py-1.5">
                  <Mono className="text-muted-foreground">{c.maxUses === null ? "∞" : num(c.maxUses)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-muted-foreground">{c.expiresAtMs ? date(c.expiresAtMs) : "Never"}</TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{num(orders)}</Mono>
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Mono>{money(discountCents)}</Mono>
                </TableCell>
                <TableCell className="px-3 py-1.5 text-right">
                  <Mono>{money(revenueCents)}</Mono>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
