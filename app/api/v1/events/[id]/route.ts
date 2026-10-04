import { apiDeps } from "@/lib/api";
import { getEventEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return getEventEndpoint(apiDeps(), request, (await params).id);
}
