// TicketBay's REMOTE MCP server: the same tools as mcp/server.ts, served over
// Streamable HTTP at /api/mcp, plus the private tools that act for a customer.
//
// Every request answers "who is calling?" first (src/mcp/caller.ts), then a
// fresh McpServer is built for that caller — the 2026-07-28 protocol is
// stateless, so nothing is shared between requests. 2025-era clients still
// work: the SDK serves them through its stateless legacy path.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { appBaseURL, getAuth } from "@/lib/auth";
import { getDb } from "@/src/db/client";
import { getPayments } from "@/src/payments";
import { resolveCaller } from "@/src/mcp/caller";
import { createTicketBayServer, PRIVATE_TOOLS, UNAUTHENTICATED_MESSAGE, type Caller } from "@/src/mcp/tools";

export const dynamic = "force-dynamic";

const handler = createMcpHandler((ctx) => {
  const caller = (ctx.authInfo?.extra?.caller ?? null) as Caller;
  return createTicketBayServer(
    { db: getDb(), payments: getPayments(), now: () => Date.now(), baseURL: appBaseURL() },
    caller,
    { includePrivate: true },
  );
});

/** HTTP 401 with a JSON-RPC error body the agent can read and act on. */
function unauthorized(message: string, id: unknown = null): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code: -32001, message } },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="TicketBay MCP"' } },
  );
}

/** A tools/call for a private tool, if that is what this body is. */
function privateToolCall(body: unknown): { id: unknown; tool: string } | null {
  const one = Array.isArray(body) ? body.find((m) => m?.method === "tools/call") : body;
  const m = one as { method?: string; id?: unknown; params?: { name?: string } } | undefined;
  const tool = m?.method === "tools/call" ? m.params?.name : undefined;
  return tool && (PRIVATE_TOOLS as readonly string[]).includes(tool) ? { id: m!.id ?? null, tool } : null;
}

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolveCaller({ auth: getAuth(), db: getDb() }, request);
  if (!resolved.ok) return unauthorized(resolved.error);

  const caller = resolved.caller;
  if (!caller) {
    // Anonymous: public tools run; a private tool gets a 401 that says how to get a key.
    const body = await request.clone().json().catch(() => null);
    const call = privateToolCall(body);
    if (call) return unauthorized(UNAUTHENTICATED_MESSAGE, call.id);
  }

  return handler.fetch(request, {
    authInfo: caller ? { token: "", clientId: "api-key", scopes: caller.scopes, extra: { caller } } : undefined,
  });
}

export async function GET(): Promise<Response> {
  return new Response("TicketBay MCP endpoint. POST JSON-RPC here (MCP Streamable HTTP).", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
