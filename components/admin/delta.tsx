import { cn } from "@/lib/utils";

/**
 * Change vs the previous period. `invert` for metrics where down is good
 * (refunds). `absolute` shows percentage points instead of a ratio.
 */
export function Delta({ cur, prev, invert, points }: { cur: number; prev: number; invert?: boolean; points?: boolean }) {
  let change: number;
  if (points) {
    change = (cur - prev) / 100; // basis points -> percentage points
  } else {
    if (prev === 0) return <span className="font-mono text-[11px] text-muted-foreground">—</span>;
    change = ((cur - prev) / prev) * 100;
  }
  const rounded = Math.round(change * 10) / 10;
  if (rounded === 0) return <span className="font-mono text-[11px] text-muted-foreground">0{points ? "pp" : "%"}</span>;
  const up = rounded > 0;
  const good = invert ? !up : up;
  return (
    <span className={cn("font-mono text-[11px] tabular-nums", good ? "text-positive" : "text-negative")}>
      {up ? "▲" : "▼"} {Math.abs(rounded).toFixed(Math.abs(rounded) < 10 ? 1 : 0)}
      {points ? "pp" : "%"}
    </span>
  );
}
