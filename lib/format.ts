// Display formatting. Money arrives as integer cents and is only ever divided
// here, at the edge, for display.

const grouped = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 });
const eurShort = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/**
 * €1,234.50 — exact for every safe-integer amount. `cents / 100` in floating
 * point is off by a cent near 2^53, so euros and cents are split with integer
 * arithmetic instead.
 */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const rest = abs % 100;
  const euros = (abs - rest) / 100;
  return `${cents < 0 ? "−" : ""}€${grouped.format(euros)}.${String(rest).padStart(2, "0")}`;
}

/** €1,235 — for KPI tiles and axes, where cents are noise. */
export function moneyShort(cents: number): string {
  if (Math.abs(cents) >= 10_000_000) return `€${(cents / 100_000).toFixed(1)}k`;
  return eurShort.format(cents / 100);
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function pct(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

const TZ = "Europe/Budapest";

/** Tue 7 Oct 2026 */
export function date(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(ms);
}

/** 7 Oct */
export function dayMonth(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ }).format(ms);
}

/** 20:00 */
export function time(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(ms);
}

/** 7 Oct 2026, 20:00 */
export function dateTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(ms);
}

export function monthShort(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: TZ }).format(ms).toUpperCase();
}

export function dayOfMonth(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", timeZone: TZ }).format(ms);
}

/** "in 12 days", "3 days ago", "today" */
export function relativeDays(targetMs: number, nowMs: number): string {
  const days = Math.round((targetMs - nowMs) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function orderNumber(id: number): string {
  return `TB-${String(id).padStart(5, "0")}`;
}
