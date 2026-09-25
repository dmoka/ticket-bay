import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNext } from "@/lib/safe-next";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; client_id?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthCard
      title="Sign in"
      description={sp.client_id ? "Sign in to connect an app to your TicketBay account." : "Book tickets and manage your orders."}
    >
      <SignInForm next={safeNext(sp.next)} mode="sign-in" />
    </AuthCard>
  );
}
