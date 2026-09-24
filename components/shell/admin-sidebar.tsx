"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, CalendarDays, LayoutDashboard, ReceiptText, TicketPercent, Undo2 } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/events", label: "Events", icon: CalendarDays },
  { href: "/admin/orders", label: "Orders", icon: ReceiptText },
  { href: "/admin/refunds", label: "Refunds", icon: Undo2 },
  { href: "/admin/codes", label: "Discount codes", icon: TicketPercent },
];

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <aside className="min-h-screen w-48 shrink-0 border-r border-border">
      <div className="sticky top-0 flex h-screen flex-col px-3 py-4">
      <Logo href="/admin" className="mb-6 px-2 text-[13px]" />
      <nav className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1 text-[13px]",
                active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto">
        <Link
          href="/"
          className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          Storefront
        </Link>
      </div>
      </div>
    </aside>
  );
}
