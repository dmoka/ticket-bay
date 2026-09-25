import { headers } from "next/headers";
import { getAuth, requireSession, appBaseURL } from "@/lib/auth";
import { keyScopes, mcpEndpoint } from "@/src/auth/auth";
import { SectionLabel } from "@/components/app/primitives";
import { ApiKeysPanel, type KeyRow } from "./api-keys-panel";

export const metadata = { title: "Developers" };

export default async function DevelopersPage() {
  await requireSession("/settings/developers");
  const auth = getAuth();
  const h = await headers();
  const listed = await auth.api.listApiKeys({ headers: h });
  const keys: KeyRow[] = (Array.isArray(listed) ? listed : listed.apiKeys).map((k) => ({
    id: k.id,
    name: k.name ?? "API key",
    start: k.start ?? "tb_",
    createdAt: new Date(k.createdAt).getTime(),
    lastUsedAt: k.lastRequest ? new Date(k.lastRequest).getTime() : null,
    canWrite: keyScopes(k.permissions).includes("tickets:write"),
  }));
  const endpoint = mcpEndpoint(appBaseURL());

  return (
    <div className="mx-auto max-w-3xl">
      <div className="text-[13px] text-muted-foreground">Settings</div>
      <h1 className="text-2xl font-semibold tracking-tight">Developers</h1>
      <p className="mt-1.5 text-muted-foreground">
        Let an AI agent book and manage tickets for you. Each key acts as you — give every agent its own, and revoke the one you no longer trust.
      </p>

      <SectionLabel className="mt-8 mb-3">MCP server</SectionLabel>
      <div className="surface space-y-3 p-5 text-[13px]">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-muted-foreground">Endpoint</span>
          <code className="font-mono text-foreground">{endpoint}</code>
        </div>
        <div>
          <div className="mb-1.5 text-muted-foreground">Claude Code, with a key:</div>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] leading-5">
            {`claude mcp add --transport http ticketbay ${endpoint} \\\n  --header "Authorization: Bearer tb_…"`}
          </pre>
        </div>
        <p className="text-muted-foreground">
          Without a key, agents can still browse events, prices and the help docs. Your orders need a key; booking and refunds need a read &amp; write key.
        </p>
      </div>

      <SectionLabel className="mt-8 mb-3">API keys</SectionLabel>
      <ApiKeysPanel keys={keys} />
    </div>
  );
}
