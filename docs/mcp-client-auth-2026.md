# Which MCP clients need OAuth, and which accept an API key header?

Researched 2026-09-25 for TicketBay's MCP server (module 6). Two kinds of evidence:

1. **Live on this repo** (localhost, TicketBay on port 3100, Claude Code 2.1.282) — see
   `docs/mcp-e2e-2026.md` for the exact commands and outputs.
2. **Official vendor docs**, quoted with URLs below. "NOT VERIFIED" means the docs did not
   say it; nothing here is filled in from memory.

## The short answer

> **2026-09-25, course decision:** TicketBay uses per-user API keys only; the MCP OAuth flow
> (Better Auth MCP plugin + CIMD) was built, proven below, and then removed from `main`.
> It is kept on commit `6dbea98` in `main`'s history (`git checkout 6dbea98`). The table shows what that means per client.

| Client | API key header | OAuth "Connect" | Works against `localhost`? | TicketBay today (keys only) |
|---|---|---|---|---|
| Claude Code (CLI) | yes (`--header`) | yes (`/mcp`, `claude mcp login`), CIMD or DCR | **yes — verified live** | **works** with a key (tested) |
| Claude.ai web / Desktop connectors | beta, limited orgs only | **yes — the main path**, CIMD or DCR | **no** — Anthropic's cloud connects | only if the org has the "Request headers" beta, and needs a public HTTPS URL |
| ChatGPT (developer mode / apps) | **no** | **yes — the only way for a user's account** | **no** — needs public HTTPS or a tunnel | **cannot connect as a customer** — ChatGPT sends no API keys |
| Cursor | yes (`headers`) | yes, **DCR or static client only** (CIMD not documented) | yes (desktop) | works with a key |
| VS Code (Copilot) | yes (`headers`) | yes, CIMD and DCR | yes | works with a key |
| Hermes agent (NousResearch, self-hosted) | **yes** — `headers:` per server, `${VAR}` from `~/.hermes/.env` | yes (`auth: oauth`) | wherever Hermes runs must reach TicketBay | **works with a key** (docs verified; not run live yet) |

**What that means for the course:** per-user API keys cover the developer tools (Claude Code,
Cursor, VS Code). Chat apps are different: ChatGPT cannot send an API key at all, and
Claude.ai / Desktop accept a key header only as a beta for some organisations — so "a chat
app connects with the user's API key" is not true for most users today. Chat apps connect
with OAuth ("Connect") from their cloud, to a public HTTPS URL. The OAuth build on
commit `6dbea98` advertised CIMD (`client_id_metadata_document_supported: true`, `none`
auth method, S256 PKCE) and no DCR endpoint; Claude Code, Claude.ai, ChatGPT and VS Code
support CIMD, Cursor's docs only describe DCR.

## Hermes agent (docs, 2026-09-25)

Source: NousResearch/hermes-agent, `website/docs/user-guide/features/mcp.md` and
`website/docs/guides/use-mcp-with-hermes.md` (main branch, fetched 2026-09-25):

```yaml
mcp_servers:
  remote_api:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer ***"
```

> "Inside an entry's `transport.command`, `transport.args`, `transport.url`, and `headers`,
> `${VAR}` placeholders are resolved at server-connect time from environment variables
> (which include everything in `~/.hermes/.env`)."

Per-server `tools: include / exclude` filtering is documented in the same guide. Hermes is
self-hosted, so the connection comes from wherever Hermes runs — that machine must reach
TicketBay's URL (localhost only if both run on the same machine).

## Verified live (2026-09-25, on the OAuth build — commit `6dbea98`)

- Claude Code's OAuth request carried `client_id=https://claude.ai/oauth/claude-code-client-metadata`
  (a CIMD URL), `code_challenge_method=S256`, `resource=http://localhost:3100/api/mcp` and the
  scopes from our protected-resource metadata (`tickets:read tickets:write offline_access`).
- Its metadata document (fetched from claude.ai): `"token_endpoint_auth_method":"none"`,
  redirect URIs `http://localhost/callback` and `http://127.0.0.1/callback`.
- A private tool called without credentials got our `401` + `WWW-Authenticate: Bearer resource_metadata=…`;
  Claude Code then fetched both discovery documents by itself and marked the server "needs sign in".
- `claude mcp login ticketbay --no-browser` → sign-in → consent → callback → "Authenticated";
  `my_orders` then ran as the signed-in customer. Disconnect in Settings → Developers → next call 401.

---

## Vendor docs: full table

| Client | Static header (`Authorization: Bearer <key>`)? | OAuth ("Connect"/sign-in flow)? | CIMD / DCR | Needs public HTTPS URL? | Sources |
|---|---|---|---|---|---|
| **Claude Code CLI** (v2.1.282 local) | **Yes.** `--header` / `-H`, `headers` in JSON, plus `headersHelper` for dynamic tokens | **Yes.** `/mcp` -> Authenticate, or `claude mcp login <name>`. Pre-registered client: `--client-id` / `--client-secret` / `--callback-port` | **Both.** CIMD auto-discovered; DCR is the default fallback. Claude Code publishes its own CIMD. Loopback redirect `http://localhost:<port>/callback` | **No** for the local CLI. It connects from the user's machine (inferred, see note). Cloud sessions get claude.ai connectors through Anthropic's proxy | code.claude.com/docs/en/mcp; claude.com/docs/connectors/building/authentication; `claude mcp add --help` |
| **Claude.ai web + Claude Desktop custom connectors** (also mobile, Cowork) | **Partial: beta, limited orgs.** "Request headers" section, org-shared credential. Choose "No sign-in" + `authorization: Bearer ...`. Not generally available | **Yes, the main path.** "Sign in now" / "Sign in when needed". Optional own OAuth client ID/secret in Advanced settings | **Both.** "Use Claude's published identity" = CIMD (recommended). "Register automatically" = DCR. CIMD is used only if AS metadata has `client_id_metadata_document_supported: true` AND `none` in `token_endpoint_auth_methods_supported`, else DCR fallback. Redirect `https://claude.ai/api/mcp/auth_callback` | **Yes.** It connects from Anthropic's cloud (`160.79.104.0/21`), even in Desktop. Localhost, VPN, and private networks do not work | support.claude.com/en/articles/11175166 (updated 2026-08-11); claude.com/docs/connectors/custom/remote-mcp; claude.com/docs/connectors/building/authentication |
| **ChatGPT** (developer mode / apps) | **No.** ChatGPT cannot "present custom API keys". Auth options: OAuth, No Authentication, Mixed | **Yes.** OAuth 2.1 per MCP auth spec. Static client credentials are also possible | **Both.** CIMD is preferred ("prioritizes CIMD when it is available"). DCR is used when chosen or when CIMD is not available. Redirect `https://chatgpt.com/connector_platform_oauth_redirect` (or `/connector/oauth/{callback_id}`) | **Yes.** Needs a public HTTPS endpoint, a dev tunnel, or OpenAI's "Secure MCP Tunnel" for private servers | developers.openai.com/api/docs/guides/developer-mode; developers.openai.com/apps-sdk/build/auth; developers.openai.com/apps-sdk/deploy/connect-chatgpt; developers.openai.com/api/docs/guides/secure-mcp-tunnels |
| **Cursor** | **Yes.** `headers` in `mcp.json`, with `${env:...}` interpolation | **Yes.** "Cursor supports OAuth for servers that require it". Static `auth` object (`CLIENT_ID`, `CLIENT_SECRET`, `scopes`) | **DCR: yes** (implied: static OAuth is "instead of dynamic client registration"). **CIMD: NOT VERIFIED.** The docs do not mention CIMD. The docs describe DCR/static only. Redirects: `http://localhost:8787/callback` (desktop), `https://www.cursor.com/agents/mcp/oauth/callback` (web/agents) | **No** for the desktop app (the doc example uses `http://localhost:3000/mcp`). Web/Cursor Agents: NOT VERIFIED | cursor.com/docs/context/mcp |
| **VS Code (Copilot agent mode)** | **Yes.** `headers` field, e.g. `{"Authorization": "Bearer ${input:api-token}"}` | **Yes.** A browser opens on first connection. Optional `oauth.clientId` | **Both.** CIMD flow is supported (1.107 notes). DCR first, then fallback to client credentials. Redirects `http://127.0.0.1:33418` and `https://vscode.dev/redirect` | **No.** The doc example uses `http://localhost:3000`. Unix sockets and named pipes are also supported | code.visualstudio.com/docs/copilot/reference/mcp-configuration; code.visualstudio.com/updates/v1_107; code.visualstudio.com/api/extension-guides/ai/mcp |

**Implication for a server design.** Serve OAuth with CIMD (advertise `client_id_metadata_document_supported: true` and `none` auth method, S256 PKCE). Keep a DCR `registration_endpoint` as a fallback. This covers all five clients. Static Bearer API keys work in Claude Code, Cursor, and VS Code. They do not work in ChatGPT. They work in claude.ai/Desktop only as a limited org beta.

---

## Per-client evidence

### 1. Claude Code (CLI)

Local evidence: `claude --version` -> `2.1.282 (Claude Code)`. `claude mcp add --help` shows:

> ```
> # Add HTTP server with headers:
>   claude mcp add --transport http corridor https://app.corridor.dev/api/mcp
> --header "Authorization: Bearer ..."
> ...
>   --callback-port <port>       Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)
>   --client-id <clientId>       OAuth client ID for HTTP/SSE servers
>   --client-secret              Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)
>   -H, --header <header...>     Set headers for HTTP/SSE servers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")
> ```

Source: https://code.claude.com/docs/en/mcp (fetched as `.md`; the page has no date, but it mentions versions up to v2.1.268)

- Static header:
  > "# Example with Bearer token
  > claude mcp add --transport http secure-api https://api.example.com/mcp \
  >   --header "Authorization: Bearer your-token""
- Dynamic headers:
  > "If your MCP server uses an authentication scheme other than OAuth, such as Kerberos, short-lived tokens, or an internal SSO, use `headersHelper` to generate request headers at connection time."
- OAuth:
  > "Many cloud-based MCP servers require authentication. Claude Code supports OAuth 2.0 for secure connections."
  > "Use `/mcp` to authenticate with remote servers that require OAuth 2.0 authentication"
  > "The `claude mcp login <name>` command runs a configured server's OAuth flow directly from your shell"
- CIMD + DCR:
  > "Some MCP servers don't support automatic OAuth setup via Dynamic Client Registration. ... Claude Code also supports servers that use a Client ID Metadata Document (CIMD) instead of Dynamic Client Registration, and discovers these automatically."
  > "You can use `--callback-port` on its own (with dynamic client registration) or together with `--client-id` (with pre-configured credentials)."
- Header vs OAuth interaction:
  > "For a server whose `Authorization` header you configured, in `headers` or through a `headersHelper`, a `401` or `403` while connecting doesn't flag the server, because the credential to fix is the one you configured."
- Cloud sessions:
  > "For a connector delivered to a cloud session, Claude Code doesn't run a sign-in flow, because the session's proxy authenticates to the connector with the authorization you granted in claude.ai."

Source: https://claude.com/docs/connectors/building/authentication

> "Claude Code runs its own OAuth flow on the user's machine and identifies itself with its own Client ID Metadata Document, so it does not use Anthropic-held credentials."
> "**Claude Code** is a native client and uses an RFC 8252 loopback redirect on an ephemeral port — for example: `http://localhost:3118/callback`. ... Claude Code declares `http://localhost/callback` and `http://127.0.0.1/callback` in its Client ID Metadata Document (https://claude.ai/oauth/claude-code-client-metadata)"

Public URL: NOT VERIFIED by an explicit doc sentence. No page says "localhost HTTP servers work." This is an inference: the local CLI makes the connection from the user's machine, and the OAuth flow "runs ... on the user's machine." Cloud sessions (Claude Code on the web) differ. They reach claude.ai connectors through Anthropic's proxy.

### 2. Claude.ai web + Claude Desktop (custom connectors)

Source: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp (updated August 11, 2026)

> "When you add a custom connector, Claude connects to your remote MCP server from Anthropic's cloud infrastructure, rather than from your local device."
> "Servers hosted on a private corporate network, behind a VPN, or blocked by a firewall won't connect, even if you can reach them from your own machine."
> "Even though Cowork and Claude Desktop run on your computer, remote connectors are configured and brokered through your Claude account. The connection to your MCP server originates from Anthropic's servers, not from your machine's network interface."
> "Custom connectors using remote MCP are available on Claude, Cowork, and Claude Desktop for users on Free, Pro, Max, Team, and Enterprise plans."
> "Optionally, click 'Advanced settings' to specify an OAuth Client ID and OAuth Client Secret for your server."

Source: https://claude.com/docs/connectors/custom/remote-mcp

- Auth modes:
  > "**Sign in now**: each user signs in through the server's OAuth flow before using it."
  > "**No sign-in**: ... If the server uses an API key, choose **No sign-in** and add the key under **Request headers**; Claude stores it as the connector's credential."
- CIMD and DCR:
  > "**Use Claude's published identity** (recommended): the server reads Claude's client details from a URL Anthropic hosts (Client ID Metadata Document)."
  > "**Register automatically**: Claude registers OAuth clients with the server as users connect (Dynamic Client Registration). Works with most servers, but adds client registrations over time."
- Static headers are a limited beta:
  > "Request header authentication is in beta and available to a limited set of organizations. If you don't see the **Request headers** section in the Add custom connector dialog, your organization doesn't have access yet."
  > "The list offers standard authentication and routing header names such as `authorization`, `x-api-key`, and `x-auth-token`, which every connector can use."
  > "For an `Authorization` header, include the scheme in the value ... `Bearer your-token`"
  > "The one exception is `Authorization`: OAuth owns that header, so it cannot be configured as a request header on an OAuth connection."

Source: https://claude.com/docs/connectors/building/authentication

> Table: "`oauth_dcr` ... Supported out of the box", "`oauth_cimd` ... Supported out of the box", "`static_headers` | Fixed credential (API key or bearer token) entered by an organization administrator ... | Beta", "`none` | No authentication (authless server) | Supported."
> "The same infrastructure backs Claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork."
> "Claude selects CIMD only when your authorization server metadata advertises **both** `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported` ... If either is missing, Claude falls back to DCR."
> "For servers expecting high traffic from the directory, prefer **CIMD or `oauth_anthropic_creds` over DCR**."
> "Claude includes a PKCE `code_challenge` with `code_challenge_method=S256` on every authorization request"
> "For the hosted Claude surfaces (Claude.ai web, Desktop, mobile, and Cowork), register the following redirect URI: `https://claude.ai/api/mcp/auth_callback`"
> "Anthropic's outbound traffic to your server originates from `160.79.104.0/21`."
> "A pure machine-to-machine `client_credentials` grant ... is **not supported**."

Spec note: this page links the 2025-11-25 spec revision. It supports CIMD and DCR equally ("out of the box") and recommends CIMD. That is consistent with the 2026-07-28 direction, but the page does not say "DCR deprecated."

### 3. ChatGPT (developer mode / apps)

Source: https://developers.openai.com/api/docs/guides/developer-mode (no date shown)

> "Supported MCP protocols: SSE and streaming HTTP."
> "Authentication supported: OAuth, No Authentication, and Mixed Authentication"
> "if static credentials are provided, then they will be used. Otherwise, ChatGPT can use Client ID Metadata Documents when the authorization server advertises support and the app creator chooses CIMD."
> "CIMD supports public-client token exchange (`none`) and signed client assertion token exchange (`private_key_jwt`). ChatGPT can also use DCR when configured."
> "Available to Pro, Plus, Business, Enterprise, and Education accounts on the web."

Source: https://developers.openai.com/apps-sdk/build/auth (no date shown; the content refers to "plugin builder", so it may be served from the plugins docs)

> "ChatGPT **does not** support machine-to-machine OAuth grants such as client credentials, service accounts, or JWT bearer assertions, nor can it present custom API keys or customer-provided mTLS certificates."
> "ChatGPT prioritizes CIMD when it is available, but the plugin builder can choose DCR when both CIMD and DCR are available."
> "If you include `registration_endpoint`, ChatGPT can register dynamically when the plugin builder chooses DCR or CIMD is not available."
> Redirect URIs: "`https://chatgpt.com/connector_platform_oauth_redirect`" (stable) or "`https://chatgpt.com/connector/oauth/{callback_id}`".

Source: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt

> "The MCP server is reachable through a public HTTPS endpoint or Secure MCP Tunnel."
> "A development tunnel or another HTTPS forwarding service can also provide an endpoint for local testing"

Source: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

> "Secure MCP Tunnel lets you connect private MCP servers to supported OpenAI products without opening inbound firewall ports or exposing those servers to the public internet."

NOT VERIFIED: help.openai.com article 12584461 ("Developer mode and MCP apps in ChatGPT") returned HTTP 403 to the fetcher.

### 4. Cursor

Source: https://cursor.com/docs/context/mcp (no date shown)

- Transport table: "Streamable HTTP | Local/Remote | Deploy as server | Multiple users | URL to an HTTP endpoint | OAuth"
- Static header:
  > `{ "mcpServers": { "server-name": { "url": "http://localhost:3000/mcp", "headers": { "API_KEY": "value" } } } }`
  > `{ "mcpServers": { "remote-server": { "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer ${env:MY_SERVICE_TOKEN}" } } } }`
  > "MCP servers use environment variables for authentication. Pass API keys and tokens through the config. Cursor supports OAuth for servers that require it."
- OAuth and DCR:
  > "For MCP servers that use OAuth, you can provide static OAuth client credentials in mcp.json instead of dynamic client registration. Use this when: ... The provider does not support OAuth 2.0 Dynamic Client Registration"
  > "If omitted, Cursor will use /.well-known/oauth-authorization-server to discover scopes_supported"
- Redirects:
  > "Web and Cursor Agents: https://www.cursor.com/agents/mcp/oauth/callback  Desktop app: http://localhost:8787/callback"
- CIMD: **NOT VERIFIED.** The docs page does not mention CIMD or Client ID Metadata Documents. A search of cursor.com found only a community forum feature request ("MCP OAuth: CIMD Support Plans and Timelines", forum.cursor.com/t/148096). That forum is not an official doc. Treat Cursor as DCR + static client only until Cursor documents CIMD. It is a DCR-only doc against the 2026-07-28 spec.
- Public URL: the desktop app connects directly. The doc example uses `http://localhost:3000/mcp`. For Cursor web/background agents, whether localhost works is NOT VERIFIED.

### 5. VS Code (GitHub Copilot agent mode)

Source: https://code.visualstudio.com/docs/copilot/reference/mcp-configuration

> "headers | No | HTTP headers for authentication or configuration | {"Authorization": "Bearer ${input:api-token}"}"
> "oauth | No | OAuth configuration for authenticating with the server | {"clientId": "example-client-id"}"
> url examples: "http://localhost:3000", "https://api.example.com/mcp"
> "When oauth is configured, VS Code handles the OAuth flow automatically. A browser window opens for authorization on the first connection to the server."
> "Input variables let you define placeholders for configuration values, avoiding the need to hardcode sensitive information like API keys"

Source: https://code.visualstudio.com/updates/v1_107 (November 2025, version 1.107)

> "These improvements come in addition to the 2025-11-25 draft features VS Code already supported, such as WWW-Authenticate scope consent, the Client ID Metadata Document authentication flow, and icons for tools, resources, and servers."

Source: https://code.visualstudio.com/api/extension-guides/ai/mcp

> "VS Code first starts with a Dynamic Client Registration (DCR) handshake and then falls back to a client-credentials workflow if the IdP does not support DCR."
> "The redirect URL list must include these URLs: http://127.0.0.1:33418 and https://vscode.dev/redirect"

Note: the extension guide still describes DCR first, with no CIMD mention. The CIMD evidence comes from the 1.107 release notes only. The order in which VS Code picks CIMD vs DCR is NOT VERIFIED.
