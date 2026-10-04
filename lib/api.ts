import { getAuth } from "@/lib/auth";
import { nowFor } from "@/lib/clock";
import { error, type ApiDeps } from "@/src/api/v1";
import { getDb } from "@/src/db/client";
import { getPayments } from "@/src/payments";

/** What the REST API (app/api/v1) runs on: the app's database, payments, auth and clock. */
export function apiDeps(): ApiDeps {
  return { db: getDb(), payments: getPayments(), auth: getAuth, now: nowFor };
}

type Handler<C> = (request: Request, ctx: C) => Promise<Response>;

/**
 * Every method a route file exports. Next.js answers a method a route does
 * not export with an empty 405 (and OPTIONS with an empty 204), so each REST
 * route exports them all: what it does not support is a JSON 405 with an
 * Allow header, and OPTIONS lists the methods as JSON.
 */
export function endpoint<C = unknown>(handlers: { GET?: Handler<C>; POST?: Handler<C> }) {
  const allow = [...Object.keys(handlers), "OPTIONS"];
  const notAllowed: Handler<C> = async (request) =>
    error(405, `${request.method} is not allowed here. This endpoint answers ${allow.join(", ")}.`, { Allow: allow.join(", ") });
  return {
    GET: handlers.GET ?? notAllowed,
    POST: handlers.POST ?? notAllowed,
    PUT: notAllowed,
    PATCH: notAllowed,
    DELETE: notAllowed,
    OPTIONS: async () => Response.json({ allow }, { headers: { Allow: allow.join(", ") } }),
  };
}

/** Same methods for a path that names no endpoint: every one is a JSON 404. */
export function noEndpoint() {
  const handler = async (): Promise<Response> => error(404, "No such endpoint. The endpoints are listed in the README, under The REST API.");
  return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler, OPTIONS: handler };
}
