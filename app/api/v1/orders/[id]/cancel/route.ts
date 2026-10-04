import { apiDeps } from "@/lib/api";
import { cancelOrderEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return cancelOrderEndpoint(apiDeps(), request, (await params).id);
}
