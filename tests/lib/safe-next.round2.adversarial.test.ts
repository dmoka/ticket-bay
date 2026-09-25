// ADVERSARIAL round 2: the new safeNext parses with new URL() and returns
// pathname + search + hash. But the parser NORMALISES dot segments, so a path
// like "/.//evil.com" comes back as "//evil.com" — a protocol-relative URL
// the browser (and router.push) sends to another host.
import { describe, it, expect } from "vitest";
import { safeNext } from "../../lib/safe-next";

const ORIGIN = "https://ticketbay.example";

describe("ADVERSARIAL round 2: safeNext's own output must stay on our origin", () => {
  it.each(["/.//evil.com", "/..//evil.com", "/a/..//evil.com", "/%2e//evil.com", "/%2E%2E//evil.com", "/./\\evil.com", "/.\\/evil.com"])(
    "%j",
    (raw) => {
      const out = safeNext(raw);
      expect(out.startsWith("//"), `safeNext returned ${JSON.stringify(out)}`).toBe(false);
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
    },
  );

  it("is idempotent: feeding the output back in gives the same same-site path", () => {
    for (const raw of ["/admin/events?cancel=ev-1&via=mcp", "/orders/7#top", "/.//evil.com"]) {
      const once = safeNext(raw);
      expect(safeNext(once)).toBe(once);
      expect(new URL(once, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});
