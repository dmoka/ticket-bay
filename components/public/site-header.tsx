import Link from "next/link";
import { Logo } from "@/components/shell/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Logo />
          <nav className="flex items-center gap-5 text-[13px] text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Events
            </Link>
            <Link href="/orders" className="hover:text-foreground">
              My orders
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Admin
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
