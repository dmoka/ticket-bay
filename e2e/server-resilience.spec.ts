// A bad request from one client must not cost another customer their order.
//
// server/server.ts parses the request body inside the try/catch (server.ts:63)
// precisely because it is reachable from the network: in an async handler a
// throw from `JSON.parse` is an unhandled rejection, and Node ends the process.
// Orders live in a Map (server.ts:21) and the seat count is a mutable field on
// a module-level object, so losing the process loses every booking anyone made
// and puts sold seats back on the market.
//
// These specs assert the customer-facing consequence: after somebody posts
// junk, an order booked BEFORE it is still cancellable for the right amount,
// and seats sold before it are still sold. Each test gets its own server via
// support/harness.ts — deliberately NOT the shared one on 4173, because a
// regression here kills the process and would take the rest of the run with it.
import { test, expect, BrowserContext, Page } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, refundLine } from "./support/ui";

// Own port range so this file never fights the other harness-based specs.
let nextPort = 4620;
const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/** Posts a body that is not JSON, the way any HTTP client on the internet can. */
async function postJunk(page: Page, url: string, body: string) {
  return page.request.post(url, { headers: { "content-type": "application/json" }, data: body });
}

test("a malformed request is refused, and the customer's order survives it", async ({ context }) => {
  const server = await startClockServer(nextPort++, nextPort++);
  running.push(server);

  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, "2");
  expect(order.totalCents).toBe(10000);

  // Junk at both money routes — they share the parse.
  const booked = await postJunk(buyer, `${server.url}/api/book`, "{oops");
  expect(booked.status(), "a body that is not JSON must be a client error, not a crash").toBe(400);
  expect(await booked.text()).toContain("error");

  const refunded = await postJunk(buyer, `${server.url}/api/refund`, "not json at all");
  expect(refunded.status(), "a body that is not JSON must be a client error, not a crash").toBe(400);
  expect(await refunded.text()).toContain("error");

  // The order was booked before the junk arrived. It must still be there, and
  // still worth exactly what it was worth: 10000 paid, 2% fee, 9800 back.
  await cancelButton(buyer).click();
  await expect(
    refundLine(buyer),
    "the customer's order did not survive somebody else's malformed request",
  ).toHaveText("Refunded: 9800 cents");
});

test("a malformed request does not put already-sold seats back on the market", async ({ context }) => {
  const server = await startClockServer(nextPort++, nextPort++);
  running.push(server);

  // Fixture: 100 seats, 40 already sold. One customer takes the remaining 60.
  const buyer = await context.newPage();
  await buyer.goto(server.url);
  await bookThroughUI(buyer, "60");

  const latecomer = await context.newPage();
  const alerts = collectDialogs(latecomer);
  await latecomer.goto(server.url);
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), { message: "expected the venue to be sold out before the junk" })
    .toContain("not enough seats");

  const res = await postJunk(latecomer, `${server.url}/api/book`, "}{");
  expect(res.status()).toBe(400);

  // Reloading also proves the server is still up: if the process had died this
  // navigation would fail outright rather than reach an assertion.
  alerts.length = 0;
  await latecomer.reload();
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), {
      message: "seats sold before the malformed request came back on sale — the server lost its inventory",
    })
    .toContain("not enough seats");
});
