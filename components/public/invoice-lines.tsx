import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface InvoiceView {
  quantity: number;
  unitCents: number;
  subtotalCents: number;
  groupPercent: number;
  earlyBirdPercent: number;
  codePercent: number;
  code: string | null;
  discountPercent: number;
  discountCents: number;
  ticketsCents: number;
  feeCents: number;
  totalCents: number;
  vatCents: number;
}

function Line({
  label,
  value,
  muted,
  strong,
  testId,
}: {
  label: React.ReactNode;
  value: string;
  muted?: boolean;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={cn("flex items-baseline justify-between gap-4 py-1", muted && "text-muted-foreground", strong && "font-medium")}
      data-testid={testId}
    >
      <span className="min-w-0">{label}</span>{" "}
      <span className="shrink-0 font-mono whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

/** The invoice module's breakdown, line by line. Every number comes from src/domain/invoice. */
export function InvoiceLines({ inv, totalLabel = "Total" }: { inv: InvoiceView; totalLabel?: string }) {
  const parts = [
    inv.groupPercent ? `group ${inv.groupPercent}%` : null,
    inv.earlyBirdPercent ? `early-bird ${inv.earlyBirdPercent}%` : null,
    inv.codePercent ? `${inv.code ?? "code"} ${inv.codePercent}%` : null,
  ].filter(Boolean);
  return (
    <div className="text-[14px]">
      <Line label={`${inv.quantity} × ${money(inv.unitCents)}`} value={money(inv.subtotalCents)} testId="line-subtotal" />
      {inv.discountCents > 0 && (
        <Line
          label={
            <>
              Discount <span className="font-mono tabular-nums">{inv.discountPercent}%</span>
              <span className="block text-[12px] text-muted-foreground">{parts.join(" + ")}</span>
            </>
          }
          value={`−${money(inv.discountCents)}`}
          testId="line-discount"
        />
      )}
      <Line label="Tickets" value={money(inv.ticketsCents)} testId="line-tickets" />
      <Line label="Service fee" value={money(inv.feeCents)} muted testId="line-fee" />
      <div className="my-2 border-t border-border" />
      <Line label={totalLabel} value={money(inv.totalCents)} strong testId="line-total" />
      <Line label="incl. VAT 27%" value={money(inv.vatCents)} muted testId="line-vat" />
    </div>
  );
}
