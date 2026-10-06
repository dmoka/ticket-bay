# Usual causes in TicketBay

Seven places where bugs come from here, most frequent first. Each names the rule and where it lives.

## 1. Boundaries (`<` vs `<=`)
A rule with a threshold breaks at the exact value. The thresholds here: seat counts (`eventStatus` in `lib/status.ts`, `seatsAvailable` in `src/domain/booking.ts`), the early-bird day count (#5), the refund time gate (#2), the fee minimum and maximum (#3). Test the exact value and one step either side (see the example).

## 2. The refund time gate
`calculateRefund` in `src/domain/refund.ts` returns 0 from the instant the event starts (`nowMs >= eventStartMs`). The same `>=` is mirrored in `src/services/orders.ts` (seats go back only while the window is open) and `cancelEvent` refuses events that already started. A bug here is usually one of the three disagreeing.

## 3. Rounding
- Refund share: `exactShare` rounds half up with BigInt. Cancelling piecemeal overshoots by up to half a cent per ticket — the caller must cap the running total (documented on `calculateRefund`).
- Refund fee: 2% of the refund, `Math.round`, minimum 50 cents, never more than the refund (`refundFee`).
- Service fee: 3%, minimum 100, maximum 2000 cents (`serviceFee` in `src/domain/fees.ts`); VAT 27% is included, not added (`vatPortion`).

## 4. Discount stacking
`buildInvoice` in `src/domain/invoice.ts`: group (5% at 5+, 10% at 10+) + early-bird 10% + code percent, added, capped at 100, rounded once on the subtotal. The fee is on the discounted amount.

## 5. The early-bird boundary
`earlyBirdApplies`: `(startMs - nowMs) / DAY_MS >= 30`. Exactly 30 days before counts; one millisecond later does not.

## 6. MCP permissions
`src/mcp/tools.ts`: each private tool needs a scope (`SCOPE` map) and answers `Forbidden (403)` without it. Someone else's order answers "Order not found." on purpose (`cancelOwnOrder` in `src/services/orders.ts`), so a user never learns another user's order exists. `cancel_event` is admin-only and only prepares a deep link; a human confirms in `/admin`.

## 7. API keys
`src/mcp/caller.ts` resolves a `tb_` key to its owner; a banned owner gets "The account behind this API key is not active." Scopes come from the key's permissions (`keyScopes`).
