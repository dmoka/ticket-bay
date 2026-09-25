import type { EventRow } from "@/src/db/schema";
import { earlyBirdApplies } from "@/src/domain/invoice";

export type EventStatus = "cancelled" | "on-sale" | "early-bird" | "few-left" | "sold-out" | "past";

export function eventStatus(ev: EventRow, nowMs: number): EventStatus {
  if (ev.cancelledAtMs !== null) return "cancelled";
  if (nowMs >= ev.startsAtMs) return "past";
  const left = ev.totalSeats - ev.seatsSold;
  if (left <= 0) return "sold-out";
  if (left / ev.totalSeats <= 0.1) return "few-left";
  if (earlyBirdApplies({ startMs: ev.startsAtMs }, nowMs)) return "early-bird";
  return "on-sale";
}

export const STATUS_LABEL: Record<string, string> = {
  "on-sale": "On sale",
  "early-bird": "Early-bird",
  "few-left": "Few left",
  "sold-out": "Sold out",
  past: "Past",
  cancelled: "Cancelled",
  paid: "Paid",
  refunded: "Refunded",
  active: "Active",
  disabled: "Disabled",
  expired: "Expired",
  exhausted: "Used up",
};

const zinc = "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700";
const green = "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-900";
const blue = "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-900";
const amber = "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-900";
const red = "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-400 dark:border-red-900";

export const STATUS_STYLE: Record<string, string> = {
  "on-sale": green,
  "early-bird": blue,
  "few-left": amber,
  "sold-out": red,
  past: zinc,
  cancelled: red,
  paid: green,
  refunded: amber,
  active: green,
  disabled: zinc,
  expired: zinc,
  exhausted: amber,
};

export const CATEGORY_LABEL: Record<string, string> = {
  concert: "Concert",
  festival: "Festival",
  conference: "Conference",
  comedy: "Comedy",
};
