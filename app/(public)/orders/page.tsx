import Link from "next/link";
import { getDb } from "@/src/db/client";
import { listOrdersByUser } from "@/src/db/orders-repo";
import { requireSession } from "@/lib/auth";
import { dateTime, date, money, orderNumber } from "@/lib/format";
import { StatusBadge } from "@/components/app/primitives";

export const metadata = { title: "My orders" };

export default async function MyOrdersPage() {
  const session = await requireSession("/orders");
  const email = session.user.email;
  const rows = await listOrdersByUser(getDb(), session.user.id);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">My orders</h1>
      <p className="mt-1.5 text-muted-foreground">Every order you booked with this account.</p>

      {(
        <div className="mt-8">
          <div className="mb-3 text-[13px] text-muted-foreground">
            {rows.length} {rows.length === 1 ? "order" : "orders"} for <span className="font-mono text-foreground">{email}</span>
          </div>
          <div className="surface overflow-hidden">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Order</th>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium">Event date</th>
                  <th className="px-4 py-2 text-right font-medium">Tickets</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ order, event }) => (
                  <tr key={order.id} className="transition-colors hover:bg-subtle">
                    <td className="px-4 py-3">
                      <Link href={`/orders/${order.id}`} className="font-mono font-medium underline-offset-2 hover:underline">
                        {orderNumber(order.id)}
                      </Link>
                      <div className="font-mono text-[12px] text-muted-foreground tabular-nums">{dateTime(order.createdAtMs)}</div>
                    </td>
                    <td className="px-4 py-3">{event.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{date(event.startsAtMs)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{order.quantity}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{money(order.totalCents)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      No orders yet — find an event and book your first tickets.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
