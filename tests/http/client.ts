// Real HTTP requests into the REST API's route handlers (app/api/v1), in
// process: a test builds a Request, hands it to the route's exported GET/POST
// — exactly what Next.js does — and reads the Response. The routes run on the
// test file's own Postgres (Testcontainers, tests/integration/database.ts);
// each test file points the app's singletons (getDb / getAuth / getPayments)
// at it, the way tests/integration/mcp-route.test.ts does.
import { TEST_CLOCK_COOKIE } from "../../lib/clock";

export const BASE_URL = "http://localhost:3000";

export interface Routes {
  listEvents(r: Request): Promise<Response>;
  getEvent(r: Request, id: string): Promise<Response>;
  quote(r: Request): Promise<Response>;
  placeOrder(r: Request): Promise<Response>;
  cancelOrder(r: Request, id: string): Promise<Response>;
}

/** The route modules, imported after the test file has wired the singletons. */
export async function loadRoutes(): Promise<Routes> {
  const events = await import("../../app/api/v1/events/route");
  const event = await import("../../app/api/v1/events/[id]/route");
  const quote = await import("../../app/api/v1/quote/route");
  const orders = await import("../../app/api/v1/orders/route");
  const cancel = await import("../../app/api/v1/orders/[id]/cancel/route");
  return {
    listEvents: (r) => events.GET(r),
    getEvent: (r, id) => event.GET(r, { params: Promise.resolve({ id }) }),
    quote: (r) => quote.POST(r),
    placeOrder: (r) => orders.POST(r),
    cancelOrder: (r, id) => cancel.POST(r, { params: Promise.resolve({ id }) }),
  };
}

export interface Call {
  method?: "GET" | "POST";
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
  if (json !== undefined || rawBody !== undefined) h["content-type"] ??= "application/json";
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
}

export async function read(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON — the assertions on `text` say so
  }
  return { status: res.status, headers: res.headers, body, text };
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
