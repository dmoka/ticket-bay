// Property tests for search_docs' ranking (src/mcp/docs.ts). Pure: no database.
//
// Invariants, in English:
//  1. Every returned section contains at least one of the query's terms — in its
//     page title, heading or text. Nothing unrelated is ever returned.
//  2. Results are sorted by score, best first (scores never increase down the list),
//     and every score is positive.
//  3. At most `limit` results come back, for any limit.
//  4. searchDocs never throws, for any query string of 2..200 characters
//     (any Unicode, prototype-ish words, only stop words, only punctuation).
//  5. Asking with a section's own heading returns that section first — on the real
//     help pages.
//  6. Results are real sections, returned verbatim: each hit equals one of the input
//     sections apart from its score, and no section is returned twice.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadHelpDocs, searchDocs, sections, terms, type DocSection } from "../../src/mcp/docs";

const HELP = loadHelpDocs();

/** A word pool that makes collisions likely: stop words, plurals, "ss" words, accents. */
const word = fc.oneof(
  fc.constantFrom(
    "refund", "refunds", "ticket", "tickets", "early", "bird", "fee", "fees", "class", "pass", "is", "the", "how", "api", "key", "keys",
    "café", "CAFE", "Refund", "early-bird", "__proto__", "constructor", "toString", "hasOwnProperty", "s", "ss", "bus", "gas",
  ),
  fc.stringMatching(/^[a-zA-Z0-9]{1,8}$/),
);
const sentence = fc.array(word, { minLength: 1, maxLength: 12 }).map((ws) => ws.join(" "));

const section = fc.record({ heading: sentence, text: sentence });
const page = fc.record({ title: sentence, sections: fc.array(section, { minLength: 1, maxLength: 5 }) });
const docsArb = fc.array(page, { minLength: 1, maxLength: 4 }).map((pages) =>
  pages.flatMap((p, i) =>
    sections(`help/p${i}.md`, `# ${p.title}\n\nIntro.\n\n${p.sections.map((s) => `## ${s.heading}\n${s.text}\n`).join("\n")}`),
  ),
);
const docsSource = fc.oneof(fc.constant(HELP), docsArb);

const anyQuery = fc.oneof(
  sentence,
  fc.string({ minLength: 2, maxLength: 200 }),
  fc.fullUnicodeString({ minLength: 2, maxLength: 200 }),
  fc.constantFrom("  ", "??", "the the the", "__proto__", "constructor prototype", "%%%%", "é́́́", "\u0000\u0000"),
);

/** The section's words, normalised the way a reader would: lower case, accents off. */
function plain(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ");
}

describe("searchDocs", () => {
  it("every hit contains a query term; sorted by score; limit respected; hits are real sections, each once", () => {
    fc.assert(
      fc.property(docsSource, anyQuery, fc.integer({ min: 1, max: 50 }), (docs: DocSection[], query, limit) => {
        const hits = searchDocs(docs, query, limit);
        expect(hits.length).toBeLessThanOrEqual(limit);
        const qWords = new Set(terms(query));
        for (const [i, h] of hits.entries()) {
          expect(h.score).toBeGreaterThan(0);
          if (i > 0) expect(h.score).toBeLessThanOrEqual(hits[i - 1].score);
          // 1. contains a query term (as a whole word of the section)
          const sectionWords = new Set(terms(`${h.page} ${h.heading} ${h.text}`));
          expect([...qWords].some((w) => sectionWords.has(w)), `"${query}" → ${h.heading}`).toBe(true);
          // and literally: some query term shows up in the section's plain text
          const hay = plain(`${h.page} ${h.heading} ${h.text}`);
          expect([...qWords].some((w) => hay.includes(w))).toBe(true);
          // 6. verbatim, real
          const { score, ...rest } = h;
          void score;
          expect(docs).toContainEqual(rest);
        }
        const keys = hits.map((h) => `${h.file}#${h.heading}#${h.text}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws for any query of 2..200 characters", () => {
    fc.assert(
      fc.property(anyQuery, fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }), (query, limit) => {
        expect(() => searchDocs(HELP, query, limit)).not.toThrow();
      }),
      { numRuns: 3000 },
    );
  });

  it("a query made of a section's own heading returns that section first (real help pages)", () => {
    const withTerms = HELP.filter((s) => terms(s.heading).length > 0);
    expect(withTerms.length).toBeGreaterThan(5);
    fc.assert(
      fc.property(fc.constantFrom(...withTerms), fc.constantFrom("", "?", " please", "How do I: "), fc.boolean(), (s, affix, upper) => {
        let q = `${affix.startsWith(" ") ? "" : affix}${s.heading}${affix.startsWith(" ") ? affix : ""}`;
        if (upper) q = q.toUpperCase();
        const [first] = searchDocs(HELP, q, 3);
        expect(first && `${first.file} › ${first.heading}`, `query "${q}"`).toBe(`${s.file} › ${s.heading}`);
      }),
      { numRuns: 300 },
    );
    // and exhaustively, every heading once, plain
    for (const s of withTerms) {
      const [first] = searchDocs(HELP, s.heading, 1);
      expect(first && `${first.file} › ${first.heading}`, `query "${s.heading}"`).toBe(`${s.file} › ${s.heading}`);
    }
  });
});
