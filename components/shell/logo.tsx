import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="grid h-4 w-4 place-items-center rounded-[4px] bg-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-background" />
      </span>
      TicketBay
    </Link>
  );
}
