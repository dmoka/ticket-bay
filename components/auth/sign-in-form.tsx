"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, redirectTarget } from "@/lib/auth-client";
import { FormError } from "./auth-card";

export function SignInForm({ next, mode }: { next: string; mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const search = useSearchParams().toString();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const res =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get("name") ?? "") });
    if (res.error) {
      setError(res.error.message ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }
    const oauth = redirectTarget(res.data);
    if (oauth) {
      window.location.href = oauth;
      return;
    }
    router.push(next);
    router.refresh();
  }

  const other = mode === "sign-in" ? "/sign-up" : "/sign-in";
  // Carry the query (next, or a signed OAuth request) over to the other form.
  const query = search ? `?${search}` : "";
  return (
    <form action={submit} className="space-y-4">
      {mode === "sign-up" && (
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required autoComplete="name" placeholder="Anna Kovács" />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
        />
      </div>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "One moment…" : mode === "sign-in" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-[13px] text-muted-foreground">
        {mode === "sign-in" ? "New to TicketBay? " : "Already have an account? "}
        <Link href={`${other}${query}`} className="text-foreground underline-offset-2 hover:underline">
          {mode === "sign-in" ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </form>
  );
}
