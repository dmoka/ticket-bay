"use client";

import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money, moneyShort } from "@/lib/format";

export interface RevenuePoint {
  label: string;
  revenueCents: number;
  prevRevenueCents: number;
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey: string; value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const cur = payload.find((p) => p.dataKey === "revenueCents")?.value ?? 0;
  const prev = payload.find((p) => p.dataKey === "prevRevenueCents")?.value ?? 0;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-[12px]">
      <div className="mb-1 text-muted-foreground">{label}</div>
      <div className="flex items-center justify-between gap-6">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-chart-1" /> Revenue
        </span>
        <span className="font-mono tabular-nums">{money(cur)}</span>
      </div>
      <div className="flex items-center justify-between gap-6 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-chart-2" /> Previous period
        </span>
        <span className="font-mono tabular-nums">{money(prev)}</span>
      </div>
    </div>
  );
}

export function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)", fontFamily: "var(--font-geist-mono)" }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)", fontFamily: "var(--font-geist-mono)" }}
            tickFormatter={(v: number) => moneyShort(v)}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border)" }} />
          <Line
            type="monotone"
            dataKey="prevRevenueCents"
            stroke="var(--chart-2)"
            strokeWidth={1.25}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="revenueCents"
            stroke="var(--chart-1)"
            strokeWidth={1.5}
            fill="url(#rev-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
