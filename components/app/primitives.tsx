import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_STYLE } from "@/lib/status";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-sm font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-px text-[11px] leading-4 font-medium whitespace-nowrap",
        STATUS_STYLE[status] ?? STATUS_STYLE.past,
        className,
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-muted/50 px-1.5 text-[11px] leading-5 text-muted-foreground">
      {children}
    </span>
  );
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("text-[11px] font-medium tracking-wide text-muted-foreground uppercase", className)}>{children}</div>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono tabular-nums", className)}>{children}</span>;
}

/** A thin sell-through bar. Grayscale track, data-colored fill. */
export function Meter({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full", v >= 1 ? "bg-chart-5" : v >= 0.9 ? "bg-chart-4" : "bg-chart-1")}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}
