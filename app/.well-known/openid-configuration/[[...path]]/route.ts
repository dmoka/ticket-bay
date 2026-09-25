// OAuth discovery lives at the site root (/.well-known/…), outside the
// /api/auth catch-all, so hand these requests to Better Auth explicitly.
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
