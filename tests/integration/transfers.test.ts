// Ticket transfer at the service layer, against a real Postgres
// (Testcontainers): the owner gives a paid order's tickets to a friend's
// account, and My orders follows the tickets. Real Better Auth accounts, the
// fake Stripe.
import { describe, it, expect } from "vitest";
import { listOrdersByUser } from "../../src/db/orders-repo";
import { createFakeStripe } from "../../src/payments";
import { placeOrder, type Deps } from "../../src/services/orders";
import { transferOrder } from "../../src/services/transfers";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";
import { customer, makeAuth, useCleanAccounts } from "./accounts";

const t = useTestDatabase();
useCleanAccounts(t);

let keys = 0;
function deps(nowMs = NOW): Deps {
  return { db: t.db, payments: createFakeStripe("sk_test_integration"), nowMs };
}

async function twoFriends() {
  const auth = makeAuth(t.db);
  return { anna: await customer(auth, "Anna"), bela: await customer(auth, "Bela") };
}

describe("transferOrder", () => {
  it("gives the tickets of a paid order to a friend before the event", async () => {
    const { anna, bela } = await twoFriends();
    const ev = await venue(t.db);
    const { order } = await placeOrder(deps(), { eventId: ev.id, quantity: 2, email: anna.email, name: "Anna", idempotencyKey: `k-${++keys}`, userId: anna.id });

    const moved = await transferOrder({ db: t.db }, anna.id, order.id, bela.email);

    expect(moved.holderId).toBe(bela.id);
    expect(moved.status).toBe("paid");
    expect(moved.quantity).toBe(2);
  });

  it("moves the order from the owner's My orders to the friend's", async () => {
    const { anna, bela } = await twoFriends();
    const ev = await venue(t.db);
    const { order } = await placeOrder(deps(), { eventId: ev.id, quantity: 3, email: anna.email, name: "Anna", idempotencyKey: `k-${++keys}`, userId: anna.id });

    await transferOrder({ db: t.db }, anna.id, order.id, `  ${bela.email.toUpperCase()} `);

    expect((await listOrdersByUser(t.db, bela.id)).map((r) => r.order.id)).toEqual([order.id]);
    expect(await listOrdersByUser(t.db, anna.id)).toEqual([]);
  });
});
