import { calculateRefund, netRefund, Order } from "./refund";

export interface CancellationPreview {
  /** false once the event has started — refunds close at `eventStartMs` */
  windowOpen: boolean;
  /** proportional share of what was paid for the tickets */
  grossCents: number;
  /** kept by the platform: 2% of the refund, min 50 cents */
  feeCents: number;
  /** what actually goes back to the customer */
  netCents: number;
  /** seats go back on sale only while the window is open */
  releasesSeats: boolean;
}

/** What cancelling a whole order at `nowMs` pays and does to inventory. */
export function previewCancellation(order: Order, nowMs: number): CancellationPreview {
  const grossCents = calculateRefund(order, order.tickets, nowMs);
  const netCents = netRefund(order, order.tickets, nowMs);
  const windowOpen = nowMs < order.eventStartMs;
  return {
    windowOpen,
    grossCents,
    feeCents: grossCents === 0 ? 0 : grossCents - netCents,
    netCents,
    releasesSeats: windowOpen,
  };
}

