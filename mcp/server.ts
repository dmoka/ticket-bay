// TicketBay's LOCAL MCP server: stdio, public tools only, no auth.
//
// The client (Claude Code, Cursor, …) starts this file as a subprocess and
// talks to it over stdin/stdout. Nothing is exposed on the network, so there
// is no one to authenticate — the MCP spec says stdio servers take any
// credentials from the environment, and these tools need none.
//
//   claude mcp add ticketbay-local -- npx tsx /path/to/ticket-bay-v2/mcp/server.ts
//
// stdout belongs to the protocol: never console.log here (use console.error).
import path from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadLocalEnv } from "../scripts/local-env";
import { getDb } from "../src/db/client";
import { createTicketBayServer } from "../src/mcp/tools";
import { getPayments } from "../src/payments";

// The client may start us from any directory; .env and drizzle/ are relative to the repo.
process.chdir(path.join(import.meta.dirname, ".."));
loadLocalEnv();

const deps = {
  db: getDb(),
  payments: getPayments(),
  now: () => Date.now(),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
};

serveStdio(() => createTicketBayServer(deps, null, { includePrivate: false }), {
  onerror: (e) => console.error("[ticketbay-mcp]", e),
});
