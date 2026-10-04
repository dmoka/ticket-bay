// QuickE2E specs for lesson 3.4: checkout, discount codes and refunds, in four kinds.
// Pinned for the recording, so the run does not depend on the cases an agent invents that day.
//
//   npm run db:seed && node e2e/quicke2e/sign-in.mjs http://localhost:3000
//   npx quicke2e run e2e/quicke2e/checkout.flows.mjs --base http://localhost:3000 --engine local
//
// Seed facts (npm run db:seed): anna@ticketbay.test owns orders 214, 281, 301 (paid) and 128
// (refunded); order 1 belongs to another customer. Midnight Arcade €45.00, no early-bird.
// Comedy Cellar €15.00, 33 seats left, early-bird 10%. Velvet Static already started.
// Codes: WELCOME10 and STUDENT15 active, SUMMER25 expired, LAUNCH50 disabled.
// Service fee 3% of tickets; refund fee 2% of tickets. Amounts are hand-computed from src/domain.
//
// The happy-path refund changes order 281: seed again before every run.
// No spec types into the Tickets field: the input key "tickets" also matches "Name on tickets".
const storageState = new URL(".auth/anna.json", import.meta.url).pathname;
const MA = "/events/midnight-arcade-neon-tour/checkout";
const CC = "/events/comedy-cellar-open-mic/checkout";

export default [
  // ---------- happy path ----------
  {
    name: "happy-checkout-2-tickets",
    kind: "happy",
    storageState,
    start: "/events/midnight-arcade-neon-tour",
    maxSteps: 10,
    goal: "Keep 2 in the Tickets field, click Continue to checkout, then click the Pay button",
    expectUrl: "/orders/\\d+\\?placed=1",
    // 2 x €45.00 = €90.00 + fee €2.70
    expect: ["Payment confirmed", "€92.70"],
  },
  {
    name: "happy-checkout-with-welcome10",
    kind: "happy",
    storageState,
    start: `${MA}?qty=2`,
    maxSteps: 12,
    inputs: { "discount code": "WELCOME10" },
    goal: "Type WELCOME10 into the Discount code field, click Apply, then click the Pay button",
    expectUrl: "/orders/\\d+\\?placed=1",
    // €90.00 - 10% = €81.00 + fee €2.43
    expect: ["Payment confirmed", "WELCOME10 10%", "€83.43"],
  },
  {
    name: "happy-refund-order-281",
    kind: "happy",
    storageState,
    start: "/orders/281",
    maxSteps: 6,
    goal: "Click Cancel order",
    // tickets €90.00, refund fee 2% = €1.80, back €88.20
    expect: ["Refund fee kept", "The seats went back on sale.", "€88.20", "€1.80"],
  },

  // ---------- boundary ----------
  {
    name: "boundary-group-discount-at-5",
    kind: "boundary",
    storageState,
    start: `${MA}?qty=5`,
    control: `${MA}?qty=4`,
    goal: "Open checkout with 5 tickets",
    // 5 x €45.00 = €225.00 - group 5% = €213.75 + fee €6.41
    expect: ["group 5%", "€220.16"],
  },
  {
    name: "boundary-one-seat-too-many",
    kind: "boundary",
    storageState,
    start: `${CC}?qty=34`,
    control: `${CC}?qty=33`,
    goal: "Open checkout with 34 tickets, one more than the seats left",
    expect: ["Not enough seats — only 33 left."],
    // the quote 34 seats would get: €510.00 - 20% = €408.00 + fee €12.24
    expectAbsent: ["€420.24"],
  },
  {
    name: "boundary-code-odd-case-and-spaces",
    kind: "boundary",
    storageState,
    start: `${MA}?qty=2`,
    maxSteps: 6,
    inputs: { "discount code": "  welcome10  " },
    goal: "Type '  welcome10  ' (lower case, with spaces around it) into the Discount code field and click Apply",
    expect: ["applied — 10% off tickets.", "€83.43"],
    expectAbsent: ["Unknown discount code."],
  },

  // ---------- refusal ----------
  {
    name: "refusal-expired-code",
    kind: "refusal",
    storageState,
    start: `${MA}?qty=2`,
    maxSteps: 6,
    inputs: { "discount code": "summer25" },
    goal: "Type summer25 into the Discount code field and click Apply",
    expect: ["This code has expired."],
    expectAbsent: ["applied —", "Discount 25%"],
  },
  {
    name: "refusal-event-already-started",
    kind: "refusal",
    storageState,
    start: "/events/velvet-static-live/checkout",
    control: `${MA}?qty=1`,
    goal: "Open checkout for the show that already started",
    expect: ["Sales are closed — this event has already started."],
    expectAbsent: ["Service fee"],
  },
  {
    name: "refusal-name-only-spaces",
    kind: "refusal",
    storageState,
    start: `${MA}?qty=1`,
    maxSteps: 8,
    inputs: { "name on tickets": "   " },
    goal: "Clear the Name on tickets field, type only three spaces into it, then click the Pay button",
    expect: ["Enter the name for the tickets."],
    expectAbsent: ["Payment confirmed"],
  },

  // ---------- attack ----------
  {
    name: "attack-two-codes-in-url",
    kind: "attack",
    storageState,
    // A repeated parameter: try to stack WELCOME10 (10%) and STUDENT15 (15%).
    start: `${MA}?qty=2&code=WELCOME10&code=STUDENT15`,
    control: `${MA}?qty=2`,
    goal: "Open checkout with two discount codes in the address",
    // At most one code applies, and the page still renders a checkout.
    expect: ["applied —"],
    expectAbsent: ["Discount 25%"],
  },
  {
    name: "attack-second-code-on-top",
    kind: "attack",
    storageState,
    start: `${MA}?qty=2&code=WELCOME10`,
    maxSteps: 8,
    inputs: { "discount code": "STUDENT15" },
    goal: "Replace the Discount code field with STUDENT15 and click Apply, trying to keep WELCOME10 too",
    expect: ["STUDENT15 applied — 15% off tickets."],
    expectAbsent: ["Discount 25%"],
  },
  {
    name: "attack-negative-qty-url",
    kind: "attack",
    storageState,
    start: `${MA}?qty=-3`,
    control: `${MA}?qty=2`,
    goal: "Open checkout with -3 tickets",
    expect: ["Choose at least one ticket."],
    expectAbsent: ["Service fee"],
  },
  {
    name: "attack-sql-looking-code",
    kind: "attack",
    storageState,
    start: `${MA}?qty=2`,
    maxSteps: 6,
    inputs: { "discount code": "' OR '1'='1" },
    goal: "Type ' OR '1'='1 into the Discount code field and click Apply",
    expect: ["Unknown discount code."],
    expectAbsent: ["applied —"],
  },
  {
    name: "attack-script-tag-name-shown-as-text",
    kind: "attack",
    storageState,
    start: `${MA}?qty=1`,
    maxSteps: 8,
    inputs: { "name on tickets": "<script>alert(1)</script>" },
    goal: "Replace the Name on tickets field with <script>alert(1)</script>, then click the Pay button",
    // The app may accept the name; it must show it back as plain text.
    expectUrl: "/orders/\\d+\\?placed=1",
    expect: ["for <script>alert(1)</script>"],
  },
  {
    name: "attack-other-users-order",
    kind: "attack",
    storageState,
    start: "/orders/1",
    control: "/orders/301",
    goal: "Open order 1",
    expect: ["Nothing here"],
    expectAbsent: ["Total paid"],
  },
];
