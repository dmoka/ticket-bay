import { AuthCard } from "@/components/auth/auth-card";
import { ConsentButtons } from "@/components/auth/consent-buttons";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/src/db/client";
import { clientNames } from "@/src/db/oauth-clients-repo";

export const metadata = { title: "Connect an app" };

// What each scope lets the app do, in the customer's words.
const SCOPE_TEXT: Record<string, string> = {
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected until you disconnect it",
  "tickets:read": "See your orders",
  "tickets:write": "Book tickets and refund orders for you",
};

/** A CIMD client_id is the URL of the app's metadata document: show its host. */
function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ client_id?: string; scope?: string }> }) {
  const sp = await searchParams;
  const session = await requireSession("/consent");
  const scopes = (sp.scope ?? "").split(" ").filter(Boolean);
  const clientId = sp.client_id ?? "";
  const name = (await clientNames(getDb(), clientId ? [clientId] : [])).get(clientId);
  return (
    <AuthCard
      title="Connect an app"
      description={
        <>
          <span className="font-medium text-foreground">{name ?? "An app"}</span>
          {clientId && <span className="font-mono text-[12px]"> ({clientHost(clientId)})</span>} wants to use your TicketBay
          account, <span className="text-foreground">{session.user.email}</span>.
        </>
      }
    >
      <div className="text-[13px] text-muted-foreground">It will be able to:</div>
      <ul className="mt-2 mb-5 space-y-1.5">
        {scopes.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/60" />
            <span>
              {SCOPE_TEXT[s] ?? s} <span className="font-mono text-[11px] text-muted-foreground">{s}</span>
            </span>
          </li>
        ))}
      </ul>
      <ConsentButtons />
      <p className="mt-4 text-[12px] text-muted-foreground">Disconnect it any time under Settings → Developers.</p>
    </AuthCard>
  );
}
