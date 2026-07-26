// Test harness — NOT application code.
//
// Boots the REAL server (server/server.ts, unmodified) in this child process with
// Date.now() frozen, and exposes a tiny control channel so a spec can move the
// clock forward. Nothing is mocked: the browser still loads the real page and
// talks to the real /api/book and /api/refund endpoints, backed by the real
// booking/refund modules. The only thing faked is what the server thinks the
// time is — otherwise "cancel after the event has started" is unreachable from a
// browser, because the demo event always starts 30 days from boot.
//
// Control channel (CONTROL_PORT):
//   GET  /clock            -> { now }
//   POST /clock/set?ms=N   -> freezes the clock at N, returns { now }
//   POST /clock/reset      -> back to boot time (well before the event), returns { now }
import { createServer } from "node:http";

const controlPort = Number(process.env.CONTROL_PORT ?? 4274);
const bootNow = Date.now();
let frozenNow = bootNow;
Date.now = () => frozenNow;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/clock/set") {
    const ms = Number(url.searchParams.get("ms"));
    if (!Number.isFinite(ms)) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad ms" }));
      return;
    }
    frozenNow = ms;
  } else if (req.method === "POST" && url.pathname === "/clock/reset") {
    frozenNow = bootNow;
  } else if (!(req.method === "GET" && url.pathname === "/clock")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ now: frozenNow }));
}).listen(controlPort, () => console.log(`clock control on http://localhost:${controlPort}`));

// Dynamic import so the Date.now patch is in place before the server module runs
// its top-level `startMs: Date.now() + 30 days`.
await import("../../server/server");
