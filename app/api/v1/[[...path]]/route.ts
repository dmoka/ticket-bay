// Any path under /api/v1 that names no endpoint — a JSON 404, never Next's HTML page.
import { noEndpoint } from "@/lib/api";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = noEndpoint();
