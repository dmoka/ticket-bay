import { apiDeps } from "@/lib/api";
import { quoteEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return quoteEndpoint(apiDeps(), request);
}
