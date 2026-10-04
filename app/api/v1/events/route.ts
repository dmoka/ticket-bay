import { apiDeps } from "@/lib/api";
import { listEventsEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return listEventsEndpoint(apiDeps(), request);
}
