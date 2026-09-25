// ADVERSARIAL: search_docs (src/mcp/docs.ts) is a PUBLIC tool — anonymous
// callers reach it. Attacks: path traversal through the query, odd/huge
// queries, regex blow-up, prototype-ish words, limit abuse.
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadHelpDocs, searchDocs, sections, terms } from "../../src/mcp/docs";

const docs = loadHelpDocs(path.join(process.cwd(), "help"));

describe("ADVERSARIAL search_docs", () => {
  it("only ever returns sections of help/*.md (never README, never anything else)", () => {
    for (const q of ["../../etc/passwd", "..\\..\\.env", "/etc/shadow", "file:///etc/passwd", "help/../.env BETTER_AUTH_SECRET", "README", "refund"]) {
      for (const h of searchDocs(docs, q, 5)) {
        expect(h.file).toMatch(/^help\/[a-z0-9-]+\.md$/);
        expect(h.file).not.toBe("help/README.md");
      }
    }
  });

  it("has no secret-looking text in any searchable section", () => {
    for (const d of docs) expect(d.text).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}|tb_[A-Za-z0-9]{16,}|BETTER_AUTH_SECRET=|postgres:\/\/\w+:\w+@/);
  });

  it.each([
    ["__proto__ constructor prototype toString hasOwnProperty", "prototype words"],
    ["the and of a to", "stop words only"],
    ["💥🎟️ ｒｅｆｕｎｄ", "emoji + full-width letters"],
    ["\u0000\u0007‮ refund", "control / bidi characters"],
    ["ß ﬁ Ǆ İ", "case-folding oddities"],
  ])("%j (%s) answers without throwing", (q) => {
    expect(() => searchDocs(docs, q, 3)).not.toThrow();
    expect(searchDocs(docs, q, 3).length).toBeLessThanOrEqual(3);
  });

  it("stays linear on pathological input (no ReDoS)", () => {
    const inputs = ["a".repeat(200_000), "a1".repeat(100_000), "## ".repeat(50_000), "s".repeat(200_000), " ".repeat(200_000) + "!"];
    for (const q of inputs) {
      const t0 = performance.now();
      terms(q);
      searchDocs(docs, q, 5);
      sections("help/x.md", `# T\n${q}\n## H\n${q}`);
      expect(performance.now() - t0, `input starting ${JSON.stringify(q.slice(0, 6))}`).toBeLessThan(1_000);
    }
  });

  // searchDocs(docs, q, -1) returns all but one hit (slice(0, -1)); the tool's
  // schema (limit 1-5) makes that unreachable, so it is not asserted here.
  it("never returns more than the limit, and nothing for a zero limit", () => {
    expect(searchDocs(docs, "refund ticket fee key discount early bird", 5).length).toBeLessThanOrEqual(5);
    expect(searchDocs(docs, "refund", 0)).toHaveLength(0);
  });
});
