import Link from "next/link";
import { cn } from "@/lib/utils";

export const TIMEFRAMES = [7, 30, 90] as const;

export function parseTimeframe(t: string | undefined): number {
  const n = Number(t);
  return (TIMEFRAMES as readonly number[]).includes(n) ? n : 30;
}

/** Segmented control; the active segment is inverted. State lives in the URL. */
export function TimeframeSelector({ days, basePath }: { days: number; basePath: string }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border font-mono text-[11px] text-muted-foreground">
      {TIMEFRAMES.map((tf) => (
        <Link
          key={tf}
          href={`${basePath}?t=${tf}`}
          className={cn("px-2.5 py-1 hover:text-foreground", tf === days && "bg-foreground text-background hover:text-background")}
          aria-current={tf === days ? "page" : undefined}
        >
          {tf}d
        </Link>
      ))}
    </div>
  );
}
