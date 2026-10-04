// Real HTTP requests into the REST API's route handlers (app/api/v1), in
// process: a test builds a Request, and `fetchApi` runs it through what
// Next.js runs — the proxy (proxy.ts), then the route file Next would pick and
// its exported method handler — then reads the Response. The routes run on the test file's
// own Postgres (Testcontainers, tests/integration/database.ts); each test file
// points the app's singletons (getDb / getAuth / getPayments) at it, the way
// tests/integration/mcp-route.test.ts does.
import { NextRequest } from "next/server";
import { afterAll, beforeAll } from "vitest";
import { TEST_CLOCK_COOKIE } from "../../lib/clock";
import { config as proxyConfig, proxy } from "../../proxy";

export const BASE_URL = "http://localhost:3000";

type RouteModule = Record<string, unknown>;

/** The route files under app/api/v1, as Next.js matches them: static and [id] segments first, the catch-all last. */
export const ROUTE_FILES = [
  "app/api/v1/events/route.ts",
  "app/api/v1/events/[id]/route.ts",
  "app/api/v1/quote/route.ts",
  "app/api/v1/orders/route.ts",
  "app/api/v1/orders/[id]/cancel/route.ts",
  "app/api/v1/organizer/payouts/route.ts",
  "app/api/v1/[[...path]]/route.ts",
];

interface Routes {
  events: RouteModule;
  event: RouteModule;
  quote: RouteModule;
  orders: RouteModule;
  cancel: RouteModule;
  payouts: RouteModule;
  catchAll: RouteModule;
}

let routes: Routes | undefined;

/** Import the route modules — after the test file has wired the singletons. */
export async function loadRoutes(): Promise<void> {
  routes = {
    events: await import("../../app/api/v1/events/route"),
    event: await import("../../app/api/v1/events/[id]/route"),
    quote: await import("../../app/api/v1/quote/route"),
    orders: await import("../../app/api/v1/orders/route"),
    cancel: await import("../../app/api/v1/orders/[id]/cancel/route"),
    payouts: await import("../../app/api/v1/organizer/payouts/route"),
    catchAll: await import("../../app/api/v1/[[...path]]/route"),
  };
}

/** Which route file Next.js serves a path under /api/v1 with, and its params. */
function route(segments: string[]): { module: RouteModule; params: Record<string, unknown> } {
  const r = routes!;
  const [a, b, c, ...rest] = segments;
  if (rest.length === 0) {
    if (a === "events" && b === undefined) return { module: r.events, params: {} };
    if (a === "events" && b !== undefined && c === undefined) return { module: r.event, params: { id: b } };
    if (a === "quote" && b === undefined) return { module: r.quote, params: {} };
    if (a === "orders" && b === undefined) return { module: r.orders, params: {} };
    if (a === "orders" && b !== undefined && c === "cancel") return { module: r.cancel, params: { id: b } };
    if (a === "organizer" && b === "payouts" && c === undefined) return { module: r.payouts, params: {} };
  }
  return { module: r.catchAll, params: segments.length ? { path: segments } : {} };
}

/**
 * Serve a request the way Next.js serves an app route: pick the route file,
 * decode the path segments into params, call the exported handler for the
 * method. A method the file does not export gets what Next sends for it — an
 * empty 405, or an empty 204 for OPTIONS — so a missing export shows up as a
 * non-JSON answer instead of being papered over here.
 */
export async function fetchApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/v1")) throw new Error(`not an API path: ${url.pathname}`);
  if (!proxyConfig.matcher.includes("/api/v1/:path*")) throw new Error("proxy.ts no longer runs for /api/v1");
  // The proxy answers first; NextResponse.next() means "go on to the route".
  const early = proxy(new NextRequest(req.url, { method: req.method, headers: req.headers })); // the proxy never reads the body
  if (early.headers.get("x-middleware-next") !== "1") return early;
  let segments: string[];
  try {
    segments = url.pathname.slice("/api/v1".length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    // What `next start` answers when it cannot decode the path into params.
    return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
  }
  const { module, params } = route(segments);
  const handler = module[req.method] as ((r: Request, ctx: { params: Promise<unknown> }) => Promise<Response>) | undefined;
  if (handler) return handler(req, { params: Promise.resolve(params) });
  if (req.method === "HEAD" && module.GET) {
    const res = await (module.GET as (r: Request, ctx: { params: Promise<unknown> }) => Promise<Response>)(req, { params: Promise.resolve(params) });
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return new Response(null, { status: req.method === "OPTIONS" ? 204 : 405 });
}

export interface Call {
  method?: string;
  path: string;
  /** sent as JSON */
  json?: unknown;
  /** sent as is — for bodies that are not valid JSON */
  rawBody?: string;
  headers?: Record<string, string>;
  /** serve the request as of this instant (the test clock cookie) */
  nowMs?: number;
}

/**
 * A Request as a client would send it. The test clock rides in a cookie, the
 * same mechanism the Playwright suite uses (lib/clock.ts); it only counts
 * while TICKETBAY_TEST_CLOCK=1.
 */
export function request({ method = "GET", path, json, rawBody, headers = {}, nowMs }: Call): Request {
  const h: Record<string, string> = { ...headers };
  if (json !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
  if (nowMs !== undefined) h.cookie = `${TEST_CLOCK_COOKIE}=${nowMs}`;
  return new Request(new URL(path, BASE_URL), {
    method,
    headers: h,
    body: rawBody ?? (json === undefined ? undefined : JSON.stringify(json)),
  });
}

export interface Reply {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  /** the body parsed as JSON — false when it is empty or not JSON */
  isJson: boolean;
}

export async function read(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: unknown = null;
  let isJson = false;
  try {
    body = JSON.parse(text);
    isJson = true;
  } catch {
    // not JSON — `isJson` and `text` say so
  }
  return { status: res.status, headers: res.headers, body, text, isJson };
}

/** Send one call through the router and read the reply. */
export const call = async (c: Call): Promise<Reply> => read(await fetchApi(request(c)));

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * Better Auth logs every refused API key as an ERROR with the whole error
 * object, five lines each. The API already answers those with a 401, and a
 * property sends hundreds of bad keys — so a test file can drop exactly those
 * lines and keep its output readable. Every other log line stays.
 */
export function quietRefusedKeyLogs() {
  const original = console.error;
  beforeAll(() => {
    console.error = (first?: unknown, ...rest: unknown[]) => {
      if (typeof first === "string" && first.includes("[Better Auth]") && first.includes("Failed to validate API key")) return;
      original(first, ...rest);
    };
  });
  afterAll(() => {
    console.error = original;
  });
}
