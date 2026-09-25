// ADVERSARIAL: the post-sign-in `next` target (lib/safe-next.ts) must stay on
// TicketBay. The sign-in form hands it to router.push, and browsers parse
// URLs with the WHATWG parser: a backslash counts as a slash and tabs/newlines
// are stripped — so "/\evil.com" is "//evil.com", another host.
import { describe, it, expect } from "vitest";
import { safeNext } from "../../lib/safe-next";

const ORIGIN = "https://ticketbay.example";

describe("ADVERSARIAL safeNext never sends a user off-site", () => {
  it.each([
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    " /\\evil.com",
  ])("%j resolves to our own origin", (raw) => {
    const target = safeNext(raw);
    expect(new URL(target, ORIGIN).origin).toBe(ORIGIN);
  });

  it("keeps real deep links intact (cancel_event's confirm link survives sign-in)", () => {
    expect(safeNext("/admin/events?cancel=ev-1&via=mcp")).toBe("/admin/events?cancel=ev-1&via=mcp");
    expect(safeNext(["/orders/5", "//evil.com"])).toBe("/orders/5");
    expect(safeNext(undefined)).toBe("/");
  });
});
