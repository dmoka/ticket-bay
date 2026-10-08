// Ticket transfer: a customer gives the tickets of a paid order to a friend
// who has a TicketBay account. The order, its payment and its price stay as
// they were; only the account that holds the tickets changes.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { getOrder, holderOf, isOrderId, setHolder } from "../db/orders-repo";
import { user, type OrderRow } from "../db/schema";
import { OrderError } from "./orders";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Transfer the tickets of one of `userId`'s orders to the account with
 * `friendEmail`. Someone else's order is "not found", as everywhere else.
 */
export async function transferOrder(deps: { db: Db }, userId: string, orderId: number, friendEmail: string): Promise<OrderRow> {
  const { db } = deps;
  const order = isOrderId(orderId) ? await getOrder(db, orderId) : undefined;
  if (!order || holderOf(order) !== userId) throw new OrderError("Order not found.");
  if (order.status !== "paid") throw new OrderError("Only a paid order can be transferred.");

  const email = friendEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new OrderError("Enter a valid email address.");
  const [friend] = await db.select().from(user).where(eq(user.email, email));
  if (!friend) throw new OrderError("No TicketBay account uses this email. Ask your friend to sign up first.");
  if (friend.id === userId) throw new OrderError("These tickets are already yours.");

  if (!(await setHolder(db, orderId, friend.id))) throw new OrderError("Only a paid order can be transferred.");
  return (await getOrder(db, orderId))!;
}
