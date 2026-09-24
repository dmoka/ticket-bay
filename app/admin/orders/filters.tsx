"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const STATUSES = [
  { value: "", label: "All" },
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded" },
];

export function OrderFilters({ events }: { events: { id: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    next.delete("peek");
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  useEffect(() => {
    if (q === (params.get("q") ?? "")) return;
    const t = setTimeout(() => update({ q }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const status = params.get("status") ?? "";
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="relative w-64">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email, name or TB-00042"
          aria-label="Search orders"
          className="h-7 pl-7 text-[13px] md:text-[13px]"
        />
      </div>
      <div className="flex overflow-hidden rounded-md border border-border text-[12px] text-muted-foreground">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => update({ status: s.value })}
            className={cn("px-2.5 py-1 hover:text-foreground", status === s.value && "bg-foreground text-background hover:text-background")}
          >
            {s.label}
          </button>
        ))}
      </div>
      <Select value={params.get("event") ?? "all"} onValueChange={(v) => update({ event: v === "all" ? "" : v })}>
        <SelectTrigger size="sm" className="w-56 text-[12px] data-[size=sm]:h-7" aria-label="Filter by event">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-[13px]">
            All events
          </SelectItem>
          {events.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-[13px]">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
