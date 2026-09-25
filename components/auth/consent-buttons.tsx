"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient, redirectTarget } from "@/lib/auth-client";
import { FormError } from "./auth-card";

export function ConsentButtons() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setPending(true);
    setError(null);
    const res = await authClient.oauth2.consent({ accept });
    const next = redirectTarget(res.data);
    if (next) {
      window.location.href = next;
      return;
    }
    setError(res.error?.message ?? "Could not finish connecting. Start again from your app.");
    setPending(false);
  }

  return (
    <div className="space-y-3">
      {error && <FormError>{error}</FormError>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => answer(false)}>
          Deny
        </Button>
        <Button className="flex-1" disabled={pending} onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
