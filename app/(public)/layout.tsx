import { SiteHeader } from "@/components/public/site-header";

export const dynamic = "force-dynamic";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col text-[14px]">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5 text-[12px] text-muted-foreground">
          <span>TicketBay — a demo ticketing platform. No real payments are taken.</span>
          <span className="font-mono">EUR · VAT 27% incl.</span>
        </div>
      </footer>
    </div>
  );
}
