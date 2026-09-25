import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth, type Auth } from "@/src/auth/auth";
import { getDb } from "@/src/db/client";

const globalForAuth = globalThis as unknown as { __ticketbayAuth?: Auth };

export function appBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  return env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

/** The app's Better Auth instance. One per process, like getDb(). */
export function getAuth(): Auth {
  if (!globalForAuth.__ticketbayAuth) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET is not set. See .env.example.");
    globalForAuth.__ticketbayAuth = createAuth(getDb(), { baseURL: appBaseURL(), secret });
  }
  return globalForAuth.__ticketbayAuth;
}

export async function getSession() {
  return getAuth().api.getSession({ headers: await headers() });
}

export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** The signed-in session, or a redirect to sign-in that comes back to `next`. */
export async function requireSession(next: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return session;
}
