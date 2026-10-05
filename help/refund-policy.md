# Refund policy

## How refunds work

You can cancel an order and get a refund at any time **until the event starts**. Cancel it under **My orders**, or ask your AI agent to do it with the `refund_order` tool.

You get back what you paid for the tickets, minus a **refund fee**:

- The refund fee is **2% of the refund, at least €0.50** (never more than the refund itself).
- The **service fee** you paid at checkout is **not refundable**.
- Your seats go back on sale.

Example: you paid €90.00 for 2 tickets plus a €2.70 service fee (€92.70 in total). Cancelling returns €90.00 − €1.80 refund fee = **€88.20**.

## Cancelling some of your tickets

You do not have to cancel a whole order. Choose how many tickets to cancel, and cancel more later, as many times as you like, **until the event starts** or none are left. Each cancellation is refunded on its own, and the seats you give back go on sale.

Partial cancellations always add up to exactly what cancelling the whole order at once would have paid: each one is priced on the running total of everything you have cancelled so far, so the refund fee and the rounding never cost you extra.

Example: of the 2 tickets above, cancelling 1 returns €45.00 − €0.90 = **€44.10**; cancelling the other later returns another **€44.10** — €88.20 in total, as for the whole order.

Before you cancel, the order page (or your AI agent, with the `quote_refund` tool) shows exactly what a cancellation would refund right now.

## A cancellation is never done twice

Every cancellation request carries an **idempotency key**: a unique string that names that one cancellation. If the same request arrives twice with the same key — a double click, or an agent retrying after a lost reply — the second one returns the result of the first and cancels nothing more.

- On the order page the key is sent for you.
- The `refund_order` tool requires an `idempotency_key`.
- The REST API requires an `Idempotency-Key` header whenever you send a number of tickets to cancel.

Use a new key for each new cancellation. A key that was already used for a different cancellation is refused.

## Refunds for early-bird tickets

Early-bird tickets are refunded like any other ticket, **based on the discounted price you actually paid**:

- You get back the early-bird price you paid, minus the 2% refund fee (at least €0.50).
- The early-bird discount is **not taken back** when you cancel, and it is **not added on top** of the refund either: the refund is always the amount you paid for the tickets.
- The same refund window applies: until the event starts.
- The service fee is not refundable.

Example: an early-bird ticket for a €50.00 event costs €45.00 (10% off). Cancelling returns €45.00 − €0.90 refund fee = **€44.10**.

The same rule covers group discounts and discount codes: refunds are always calculated from what you paid, after every discount.

## After the event has started

Once the event starts, the refund window is closed:

- You can **no longer cancel some of your tickets**: a partial cancellation is refused.
- You can still cancel the whole order (every ticket you still hold). That refunds **nothing**, and the seats stay yours.

## When we cancel an event

If the organiser cancels an event, every paid order is refunded **in full for the ticket price — no refund fee**, and you do not need to do anything. The service fee is not refunded.

If you had already cancelled some of the tickets yourself, you get the ticket price for the tickets you still hold, with no fee. The refund fees of your earlier cancellations are not given back.
