import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNext } from "@/lib/safe-next";

export const metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthCard title="Create your account" description="One account for booking, your orders and your API keys.">
      <SignInForm next={safeNext(sp.next)} mode="sign-up" />
    </AuthCard>
  );
}
