# AI agents and API keys

## Connect your AI agent

TicketBay has an MCP server, so an AI agent (Claude Code, Cursor, VS Code…) can browse, book and refund for you. Create an API key under **Settings → Developers** and give it to your agent as `Authorization: Bearer tb_…`. Browsing events, prices and these help pages needs no key.

## Key scopes

- **Read only**: the agent can browse and see your orders. It cannot book or refund.
- **Read & write**: the agent can also book tickets and refund orders for you.

Give each agent its own key, with the smallest scope it needs.

## Revoke a key

Revoke a key under **Settings → Developers**. The agent using it is locked out at once. Rotate a key to replace its secret and keep its name and scope.
