# QuickE2E demo specs (course lesson 3.4)

**This branch (`demo/quicke2e-attacks`) freezes a real bug for the course demo. Do not merge it to main.**

The bug: `/events/<id>/checkout?qty=1&code=WELCOME10&code=STUDENT15` answers HTTP 500 for a signed-in
user. `app/(public)/events/[id]/checkout/page.tsx:33` runs `(sp.code ?? "").trim()`; Next.js passes a
repeated query parameter as an array, so `.trim` is not a function. No money moves. A fix on main must
not reach this branch, so the attack spec `attack-two-codes-in-url` keeps failing with `SERVER_ERROR`.

`checkout.flows.mjs` is a pinned set of 15 specs: 3 happy paths, 3 boundary, 3 refusal and 6 attack
cases. It is pinned so the recording does not depend on the cases an agent invents that day. These files
are not Playwright tests: `npm run test:ui` does not pick them up.

## Run it

QuickE2E 0.2.0 on npm has no `expectAbsent`, `control` or `SERVER_ERROR`. Install a build of
[dmoka/quicke2e](https://github.com/dmoka/quicke2e) main (41d11c6 or later) until a newer version is published.

```bash
npm run db:up && npm run db:migrate
npm run dev                                         # http://localhost:3000

npm run db:seed                                     # every run: the happy-path refund changes order 281
node e2e/quicke2e/sign-in.mjs http://localhost:3000 # saves e2e/quicke2e/.auth/anna.json (gitignored)
npx quicke2e run e2e/quicke2e/checkout.flows.mjs --base http://localhost:3000 --engine local
```

`--engine local` needs the QuickE2E local engine (`local-engine/server.py --model shisa-de-1`). Without it,
drop `--engine local` and set `OPENROUTER_API_KEY` for hosted Jev.

Expected: 14 PASS and one FAIL, `attack-two-codes-in-url  0 steps  SERVER_ERROR  HTTP 500  (attack)`.
