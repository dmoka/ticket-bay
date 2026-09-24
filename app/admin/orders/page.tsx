import Link from "next/link";
import { getDb } from "@/src/db/client";
import { listOrdersAdmin, type OrderSort } from "@/src/db/admin-queries";
import { listEvents } from "@/src/db/events-repo";
import { getOrderWithEvent } from "@/src/db/orders-repo";
import { num } from "@/lib/format";
import { Mono, PageHeader } from "@/components/app/primitives";
import { OrderFilters } from "./filters";
import { OrdersTable } from "./orders-table";

export const metadata = { title: "Orders" };

const PAGE_SIZE = 50;
const SORTS: OrderSort[] = ["created", "total", "quantity", "event"];

type SP = { status?: string; event?: string; q?: string; sort?: string; dir?: string; page?: string; peek?: string };

export default async function AdminOrders({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = getDb();
  const page = Math.max(1, Number(sp.page) || 1);
  const { rows, total } = await listOrdersAdmin(db, {
    status: sp.status === "paid" || sp.status === "refunded" ? sp.status : undefined,
    eventId: sp.event || undefined,
    q: sp.q,
    sort: SORTS.includes(sp.sort as OrderSort) ? (sp.sort as OrderSort) : "created",
    dir: sp.dir === "asc" ? "asc" : "desc",
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const peekId = Number(sp.peek);
  const peek = Number.isSafeInteger(peekId) && peekId > 0 ? ((await getOrderWithEvent(db, peekId)) ?? null) : null;
  const events = (await listEvents(db)).map((e) => ({ id: e.id, name: e.name }));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const next = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "peek") as [string, string][]);
    next.set("page", String(p));
    return `/admin/orders?${next}`;
  };

  return (
    <>
      <PageHeader
        title="Orders"
        description={
          <>
            <Mono>{num(total)}</Mono> orders match · click a row to peek
          </>
        }
      />
      <OrderFilters events={events} />
      <div className="surface">
        <OrdersTable key={`${sp.peek ?? ""}`} rows={rows} initialPeek={peek} />
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
          <span>
            <Mono>
              {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)}
            </Mono>{" "}
            of <Mono>{num(total)}</Mono>
          </span>
          <div className="flex items-center gap-3">
            {page > 1 ? (
              <Link href={link(page - 1)} className="hover:text-foreground">
                ← Previous
              </Link>
            ) : (
              <span className="opacity-40">← Previous</span>
            )}
            <Mono>
              {page} / {pages}
            </Mono>
            {page < pages ? (
              <Link href={link(page + 1)} className="hover:text-foreground">
                Next →
              </Link>
            ) : (
              <span className="opacity-40">Next →</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
