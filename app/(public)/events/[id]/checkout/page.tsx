import Link from "next/link";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getEvent } from "@/src/db/events-repo";
import { checkCode, OrderError, quoteOrder, type QuoteResult } from "@/src/services/orders";
import { now } from "@/lib/clock";
import { date, money, time } from "@/lib/format";
import { SectionLabel } from "@/components/app/primitives";
import { InvoiceLines } from "@/components/public/invoice-lines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Checkout" };

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ qty?: string; code?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const ev = getEvent(db, id);
  if (!ev) notFound();
  const nowMs = await now();
  const qty = Number(sp.qty ?? 1);
  const rawCode = (sp.code ?? "").trim();

  const codeCheck = rawCode ? checkCode({ db, nowMs }, rawCode) : null;
  const codeError = codeCheck && !codeCheck.ok ? codeCheck.reason : null;
  let result: QuoteResult | null = null;
  let error: string | null = null;
  try {
    // A bad code never blocks the order: quote without it and say why.
    result = quoteOrder({ db, nowMs }, id, qty, codeCheck?.ok ? rawCode : "");
  } catch (e) {
    if (!(e instanceof OrderError)) throw e;
    error = e.message;
  }
  const appliedCode = result?.code?.code ?? "";
  const email = (await cookies()).get("tb-email")?.value ?? "";

  return (
    <div>
      <nav className="mb-6 text-[13px] text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          Events
        </Link>
        <span className="mx-1.5">/</span>
        <Link href={`/events/${ev.id}`} className="hover:text-foreground">
          {ev.name}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">Checkout</span>
      </nav>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Checkout</h1>

      <div className="grid grid-cols-1 gap-10 md:grid-cols-[1fr_380px]">
        <section>
          <SectionLabel className="mb-3">Your details</SectionLabel>
          <div className="surface p-5">
            <CheckoutForm
              eventId={ev.id}
              qty={qty}
              code={appliedCode}
              idempotencyKey={randomUUID()}
              payLabel={result ? `Pay ${money(result.invoice.totalCents)}` : "Pay"}
              disabled={!result}
              defaultEmail={email}
            />
          </div>
        </section>

        <aside>
          <SectionLabel className="mb-3">Order summary</SectionLabel>
          <div className="surface divide-y divide-border">
            <div className="p-5">
              <div className="font-medium">{ev.name}</div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {date(ev.startsAtMs)} · <span className="font-mono tabular-nums">{time(ev.startsAtMs)}</span> · {ev.venue}
              </div>
              <form method="get" className="mt-4 flex items-end gap-2">
                {appliedCode && <input type="hidden" name="code" value={appliedCode} />}
                <div className="flex-1">
                  <label htmlFor="qty" className="mb-1.5 block text-[13px] font-medium">
                    Tickets
                  </label>
                  <Input id="qty" name="qty" type="number" min={1} defaultValue={Number.isFinite(qty) ? qty : 1} className="font-mono tabular-nums" />
                </div>
                <Button type="submit" variant="outline">
                  Update
                </Button>
              </form>
            </div>

            <div className="p-5">
              {error ? (
                <div role="alert" data-testid="checkout-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                  {error}
                </div>
              ) : (
                result && (
                  <InvoiceLines
                    inv={{
                      ...result.invoice,
                      quantity: qty,
                      unitCents: ev.priceCents,
                      code: result.code?.code ?? null,
                    }}
                  />
                )
              )}
            </div>

            <div className="p-5">
              <form method="get" className="flex items-end gap-2">
                <input type="hidden" name="qty" value={Number.isFinite(qty) ? qty : 1} />
                <div className="flex-1">
                  <label htmlFor="code" className="mb-1.5 block text-[13px] font-medium">
                    Discount code
                  </label>
                  <Input id="code" name="code" defaultValue={rawCode} placeholder="e.g. WELCOME10" className="font-mono uppercase" />
                </div>
                <Button type="submit" variant="outline">
                  Apply
                </Button>
              </form>
              {codeError && <p className="mt-2 text-[13px] text-red-600 dark:text-red-400">{codeError}</p>}
              {result?.code && (
                <p className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-400">
                  <span className="font-mono">{result.code.code}</span> applied — {result.code.percent}% off tickets.
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
