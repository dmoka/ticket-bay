# AI agents and API keys

## Connect your AI agent

TicketBay has an MCP server, so an AI agent (Claude Code, Cursor, VS Code…) can browse, book and refund for you. Create an API key under **Settings → Developers** and give it to your agent as `Authorization: Bearer tb_…`. Browsing events, prices and these help pages needs no key.

## Key scopes

- **Read only**: the agent can browse and see your orders. It cannot book or refund.
- **Read & write**: the agent can also book tickets and refund orders for you.

Give each agent its own key, with the smallest scope it needs.

## Refund limit for agents

An agent can refund **up to €100.00** per order by itself. For a bigger refund, the `refund_order` tool makes no refund: it gives your agent a link to the order's page, and you click **Cancel order** there yourself. Nothing changes until you do.

## Revoke a key

Revoke a key under **Settings → Developers**. The agent using it is locked out at once. Rotate a key to replace its secret and keep its name and scope.
