/**
 * A same-site path to return to after sign-in; anything else goes home.
 * Parse it the way the browser will — "/\evil.com", "/\t/evil.com" and
 * "/.//evil.com" look like paths, but a URL parser turns them into another
 * host or a protocol-relative "//evil.com" — and keep only a result that is
 * still a plain path on our origin.
 */
export function safeNext(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/")) return "/";
  const base = "http://ticketbay.invalid";
  try {
    const url = new URL(v, base);
    const out = url.pathname + url.search + url.hash;
    // The normalised path must itself be safe: one leading slash, no backslash.
    if (url.origin !== base || !out.startsWith("/") || out.startsWith("//") || out.includes("\\")) return "/";
    return new URL(out, base).origin === base ? out : "/";
  } catch {
    return "/";
  }
}
