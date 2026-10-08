import { apiDeps, endpoint } from "@/lib/api";
import { transferOrderEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = endpoint<{ params: Promise<{ id: string }> }>({
  POST: async (request, { params }) => transferOrderEndpoint(apiDeps(), request, (await params).id),
});
