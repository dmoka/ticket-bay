import { getAuth } from "@/lib/auth";
import { nowFor } from "@/lib/clock";
import type { ApiDeps } from "@/src/api/v1";
import { getDb } from "@/src/db/client";
import { getPayments } from "@/src/payments";

/** What the REST API (app/api/v1) runs on: the app's database, payments, auth and clock. */
export function apiDeps(): ApiDeps {
  return { db: getDb(), payments: getPayments(), auth: getAuth, now: nowFor };
}
