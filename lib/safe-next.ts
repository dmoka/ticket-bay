/**
 * A same-site path to return to after sign-in; anything else goes home.
 * Parse it the way the browser will — "/\evil.com" and "/\t/evil.com" look
 * like paths but a URL parser turns them into another host — and keep it only
 * if it stays on our origin.
 */
export function safeNext(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/")) return "/";
  const base = "http://ticketbay.invalid";
  try {
    const url = new URL(v, base);
    if (url.origin !== base) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
