import { AdminSidebar } from "@/components/shell/admin-sidebar";
import { AdminTopbar } from "@/components/shell/admin-topbar";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Admin", template: "%s · TicketBay Admin" } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen text-[13px]">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopbar />
        <main className="flex-1 px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
