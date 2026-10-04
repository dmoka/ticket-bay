import { apiDeps, endpoint } from "@/lib/api";
import { listEventsEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = endpoint({
  GET: (request) => listEventsEndpoint(apiDeps(), request),
});
