import { AdminSidebar } from "@/components/shell/admin-sidebar";
import { AdminTopbar } from "@/components/shell/admin-topbar";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Admin", template: "%s · TicketBay Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession("/admin");
  if (session.user.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-[14px]">
        <div className="surface max-w-sm p-6 text-center">
          <h1 className="font-semibold">Admins only</h1>
          <p className="mt-1.5 text-muted-foreground">
            You are signed in as <span className="font-mono">{session.user.email}</span>, which is not an admin account.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen text-[13px]">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopbar name={session.user.name} />
        <main className="flex-1 px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
