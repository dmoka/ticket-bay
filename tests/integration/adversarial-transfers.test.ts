// ADVERSARIAL: ticket transfer (src/services/transfers.ts) at the service
// layer, against a real Postgres (Testcontainers), real Better Auth accounts,
// the fake Stripe. Attacks the acceptance criteria in
// docs/specs/ticket-transfer-4.3-start.md:
//   3. A transfer is possible only before the event starts.
//   5. A transferred ticket can't be refunded by the old owner.
// and documents the cases the criteria never decide (holder's refund,
// onward transfer, transfer back, two transfers at once).
import { describe, it, expect } from "vitest";
import { getEvent } from "../../src/db/events-repo";
import { getOrder, listOrdersByUser } from "../../src/db/orders-repo";
import { createFakeStripe } from "../../src/payments";
import { cancelOwnOrder, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { transferOrder } from "../../src/services/transfers";
import { useTestDatabase } from "./database";
import { DAY, HOUR, NOW, venue } from "./fixtures";
import { customer, makeAuth, useCleanAccounts } from "./accounts";

const t = useTestDatabase();
useCleanAccounts(t);

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    return (e as Error).message;
  }
  throw new Error("expected an OrderError");
}

let keys = 0;
function deps(nowMs = NOW): Deps {
  return { db: t.db, payments: createFakeStripe("sk_test_integration"), nowMs };
}
function bookAs(d: Deps, userId: string, eventId: string, quantity: number) {
  return placeOrder(d, { eventId, quantity, email: "fan@example.com", name: "A Fan", idempotencyKey: `k-${++keys}`, userId });
}

async function threeFriends() {
  const auth = makeAuth(t.db);
  return { anna: await customer(auth, "Anna"), bela: await customer(auth, "Bela"), carl: await customer(auth, "Carl") };
}

describe("criterion 5: a transferred ticket can't be refunded by the old owner", () => {
  it("the old owner's cancelOwnOrder is refused after the transfer, the order stays paid and held by the friend", async () => {
    const { anna, bela } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    await transferOrder({ db: t.db }, anna.id, order.id, bela.email);
    expect((await getOrder(t.db, order.id))!.holderId).toBe(bela.id);

    // Expected by the spec: the old owner can no longer refund these tickets.
    expect(await refused(cancelOwnOrder(d, anna.id, order.id))).toBe("Order not found.");

    const still = (await getOrder(t.db, order.id))!;
    expect(still.status).toBe("paid");
    expect(still.holderId).toBe(bela.id);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
    // The friend still sees the paid order in My orders.
    expect((await listOrdersByUser(t.db, bela.id)).map((r) => r.order.status)).toEqual(["paid"]);
  });
});

describe("criterion 3: a transfer is possible only before the event starts", () => {
  it("refuses to transfer an order for an event that has already started", async () => {
    const { anna, bela } = await threeFriends();
    // Started a day ago on every clock: the fixtures' NOW and the wall clock.
    const startsAtMs = Math.min(NOW, Date.now()) - DAY;
    const ev = await venue(t.db, { startsAtMs, createdAtMs: startsAtMs - 30 * DAY });
    const { order } = await bookAs(deps(startsAtMs - HOUR), anna.id, ev.id, 2);

    await expect(transferOrder({ db: t.db }, anna.id, order.id, bela.email)).rejects.toBeInstanceOf(OrderError);

    const still = (await getOrder(t.db, order.id))!;
    expect(still.holderId).toBeNull();
    expect((await listOrdersByUser(t.db, bela.id))).toEqual([]);
  });
});

describe("undecided by the spec — documents what the code does", () => {
  it("the new holder cannot refund the order it holds: cancelOwnOrder answers 'Order not found.'", async () => {
    // The order page (app/(public)/orders/[id]/page.tsx) shows the holder the
    // Cancel form; the action behind it refuses. Who may refund after a
    // transfer, and to whose card, is a decision nobody made.
    const { anna, bela } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    await transferOrder({ db: t.db }, anna.id, order.id, bela.email);

    expect(await refused(cancelOwnOrder(d, bela.id, order.id))).toBe("Order not found.");
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");
  });

  it("the friend can transfer the tickets onward to a third account, and back to the buyer", async () => {
    const { anna, bela, carl } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    await transferOrder({ db: t.db }, anna.id, order.id, bela.email);

    // Onward: bela → carl. The buyer (anna) is not asked.
    const onward = await transferOrder({ db: t.db }, bela.id, order.id, carl.email);
    expect(onward.holderId).toBe(carl.id);
    expect((await listOrdersByUser(t.db, bela.id))).toEqual([]);
    // Back: carl → anna. holderId then equals userId (not null).
    const back = await transferOrder({ db: t.db }, carl.id, order.id, anna.email);
    expect(back.holderId).toBe(anna.id);
    expect((await listOrdersByUser(t.db, anna.id)).map((r) => r.order.id)).toEqual([order.id]);
  });

  it("two transfers of the same order at the same moment both succeed; the last write wins", async () => {
    const { anna, bela, carl } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);

    const results = await Promise.allSettled([
      transferOrder({ db: t.db }, anna.id, order.id, bela.email),
      transferOrder({ db: t.db }, anna.id, order.id, carl.email),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const holder = (await getOrder(t.db, order.id))!.holderId;
    // Record the outcome: how many calls were told "done", and who holds the tickets.
    expect(fulfilled.length).toBe(2);
    expect([bela.id, carl.id]).toContain(holder);
  });
});

describe("hunted, survived", () => {
  it("someone else's order is 'Order not found.' and nothing changes", async () => {
    const { anna, bela, carl } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 1);
    expect(await refused(transferOrder({ db: t.db }, bela.id, order.id, carl.email))).toBe("Order not found.");
    expect((await getOrder(t.db, order.id))!.holderId).toBeNull();
  });

  it("a refunded order cannot be transferred", async () => {
    const { anna, bela } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 1);
    await cancelOwnOrder(d, anna.id, order.id);
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, bela.email))).toBe("Only a paid order can be transferred.");
    expect((await getOrder(t.db, order.id))!.holderId).toBeNull();
  });

  it("transfer to yourself, to an unknown email, and to a malformed email are refused", async () => {
    const { anna } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 1);
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, `  ${anna.email.toUpperCase()} `))).toBe("These tickets are already yours.");
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, "nobody@example.com"))).toContain("No TicketBay account");
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, "not-an-email"))).toBe("Enter a valid email address.");
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, ""))).toBe("Enter a valid email address.");
    expect((await getOrder(t.db, order.id))!.holderId).toBeNull();
  });

  it("an order placed before accounts existed (no user id) belongs to nobody", async () => {
    const { anna, bela } = await threeFriends();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await placeOrder(d, { eventId: ev.id, quantity: 1, email: anna.email, name: "Anna", idempotencyKey: `k-${++keys}` });
    expect(order.userId).toBeNull();
    expect(await refused(transferOrder({ db: t.db }, anna.id, order.id, bela.email))).toBe("Order not found.");
  });

  it("non-integer and unknown order ids are 'Order not found.'", async () => {
    const { anna, bela } = await threeFriends();
    for (const id of [Number.NaN, 1.5, -1, 0, 424242, 2_147_483_648]) {
      expect(await refused(transferOrder({ db: t.db }, anna.id, id, bela.email))).toBe("Order not found.");
    }
  });
});
