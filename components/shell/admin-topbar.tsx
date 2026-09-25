import { ThemeToggle } from "@/components/shell/theme-toggle";

export function AdminTopbar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <header className="flex h-11 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="rounded-full border border-border px-2 py-0.5">TicketBay Ops</span>
        <span className="font-mono">EUR</span>
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <div className="flex h-7 items-center gap-2 px-2 text-[12px]">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted font-mono text-[10px]">{initials || "OP"}</span>
          {name}
        </div>
      </div>
    </header>
  );
}
