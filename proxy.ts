// Pages that need an account send signed-out visitors to /sign-in with the
// FULL path and query as `next` — so a deep link such as the cancel_event
// tool's /admin/events?cancel=… survives the sign-in. This only checks that a
// session cookie exists (fast, no database); the pages still verify the
// session and the role themselves. Requests to the REST API (/api/v1) only
// get their URL checked here; the routes do their own auth.
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/v1")) return apiPath(request);
  if (getSessionCookie(request)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const signIn = new URL("/sign-in", request.url);
  signIn.searchParams.set("next", pathname + search);
  return NextResponse.redirect(signIn);
}

/**
 * The REST API answers in JSON, even for a path that is not valid
 * percent-encoding ("/api/v1/events/%E0%A4%A"): Next.js would fail to decode
 * it into route params and answer a plain-text 500 before any route runs.
 */
function apiPath(request: NextRequest) {
  try {
    decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return NextResponse.json({ error: "The URL is not valid percent-encoding." }, { status: 400 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/v1/:path*", "/admin/:path*", "/orders/:path*", "/settings/:path*", "/events/:id/checkout"],
};
