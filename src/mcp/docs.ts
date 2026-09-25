// search_docs: keyword search over the help pages in help/*.md, so an agent
// answers "how do refunds work for early-bird tickets?" from the policy
// instead of from memory. Each "## " section is one searchable unit.
//
// Plain term matching, no embeddings: a few pages, a few dozen sections.
// Revisit when the help centre outgrows that.
import fs from "node:fs";
import path from "node:path";

export interface DocSection {
  /** help/refund-policy.md */
  file: string;
  page: string;
  heading: string;
  text: string;
}

export interface DocHit extends DocSection {
  score: number;
}

const STOP = new Set(
  "a an and are as at be by can do does for from how i if in is it my of on or the to what when where which who why will with you your".split(" "),
);

/** Lower-case words, stop words dropped, a plural "s" trimmed ("tickets" → "ticket"). */
export function terms(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Split one markdown page into its "## " sections (the text before the first one is the intro). */
export function sections(file: string, markdown: string): DocSection[] {
  const page = /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? path.basename(file, ".md");
  const out: DocSection[] = [];
  for (const chunk of markdown.split(/^## /m).slice(1)) {
    const [heading, ...body] = chunk.split("\n");
    const text = body.join("\n").trim();
    if (text) out.push({ file, page, heading: heading.trim(), text });
  }
  return out;
}

export function loadHelpDocs(dir = path.join(process.cwd(), "help")): DocSection[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .flatMap((f) => sections(`help/${f}`, fs.readFileSync(path.join(dir, f), "utf8")));
}

/**
 * Rank sections by how many distinct query terms they contain; a term in the
 * heading or page title counts three times. Sections matching nothing are dropped.
 */
export function searchDocs(docs: DocSection[], query: string, limit = 3): DocHit[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0) return [];
  return docs
    .map((d) => {
      const title = new Set(terms(`${d.page} ${d.heading}`));
      const body = new Set(terms(d.text));
      const score = q.reduce((s, t) => s + (title.has(t) ? 3 : 0) + (body.has(t) ? 1 : 0), 0);
      return { ...d, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}
