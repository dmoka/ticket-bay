import { apiDeps, endpoint } from "@/lib/api";
import { organizerInvoicesEndpoint } from "@/src/api/v1";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = endpoint({
  GET: (request) => organizerInvoicesEndpoint(apiDeps(), request),
});
