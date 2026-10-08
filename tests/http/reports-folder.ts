// The invoice route writes its files to ./reports (gitignored) — the app's own
// folder, since a route has no other. A test file that drives the route
// registers this once: at the end it removes the invoice files the run added
// and cuts outbox.log back to its size before, so a thousand generated
// requests leave no litter behind.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export function tidyReportsFolder() {
  const dir = path.join(process.cwd(), "reports");
  const outbox = path.join(dir, "outbox.log");
  let before = new Set<string>();
  let outboxSize: number | null = null;

  beforeAll(() => {
    before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    outboxSize = fs.existsSync(outbox) ? fs.statSync(outbox).size : null;
  });

  afterAll(() => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (/^invoices-.*\.(csv|txt)$/.test(name) && !before.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
    if (outboxSize === null) fs.rmSync(outbox, { force: true });
    else if (fs.existsSync(outbox)) fs.truncateSync(outbox, outboxSize);
  });
}
