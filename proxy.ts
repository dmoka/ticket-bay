// Pages that need an account send signed-out visitors to /sign-in with the
// FULL path and query as `next` — so a deep link such as the cancel_event
// tool's /admin/events?cancel=… survives the sign-in. This only checks that a
// session cookie exists (fast, no database); the pages still verify the
// session and the role themselves.
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const signIn = new URL("/sign-in", request.url);
  signIn.searchParams.set("next", pathname + search);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ["/admin/:path*", "/orders/:path*", "/settings/:path*", "/events/:id/checkout"],
};
