import { apiDeps, endpoint } from "@/lib/api";
import { cancelQuoteEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = endpoint<{ params: Promise<{ id: string }> }>({
  GET: async (request, { params }) => cancelQuoteEndpoint(apiDeps(), request, (await params).id),
});
