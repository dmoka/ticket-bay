import { apiDeps, endpoint } from "@/lib/api";
import { quoteEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = endpoint({
  POST: (request) => quoteEndpoint(apiDeps(), request),
});
