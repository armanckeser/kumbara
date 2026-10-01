// The drill-in behind a pressable position row.
//
// The table answers "how much". The question behind the tap is "what IS this, and should I worry" —
// which needs facts the table cannot fit. Three of them, in the order they get asked:
//
//   1. Per-share numbers. A total market value cannot be checked against anything; "$426.40/share
//      against a $483.31 basis" can be checked against a public quote in one glance. This is the fix
//      for "I can't learn more about what I invested in".
//   2. Where it is held. The same ticker in two brokerages is ONE exposure but routinely TWO different
//      cost bases, and the blended number hides which account holds the underwater shares.
//   3. How big a bet it is. Share of the whole portfolio, so concentration is legible at the position.
//
// Every number is read off the shared pure derivation (domain/holding.ts buildPositionDetail) — this
// file assembles nothing and decides nothing (R2). Rendered as a Sheet with ONE overlay: it is opened
// from a plain row press, never stacked on another sheet (see sheet-panes.ts for why that matters).

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { PositionDetail } from "../../../domain/holding";
import { Amount } from "../transactions/amount";
import { usd } from "../budget/summary";

/** Signed dollars with an explicit sign, colored by DIRECTION only (up = success, down = danger) —
 *  never by magnitude. An unknown gain stays neutral, never a misleading green zero. */
function GainText({ absolute, percent }: { absolute: number | null; percent: number | null }) {
  if (absolute === null) return <span className="text-text-muted">—</span>;
  return (
    <span className={absolute >= 0 ? "text-emerald-400" : "text-rose-400"}>
      {absolute >= 0 ? "+" : ""}
      {usd(absolute)}
      {percent !== null && (
        <span className="ml-1 text-xs">
          ({percent >= 0 ? "+" : ""}
          {(percent * 100).toFixed(1)}%)
        </span>
      )}
    </span>
  );
}

/** One label/value line. Values are tabular so the column scans vertically. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm tabular-nums text-text-primary">{children}</span>
    </div>
  );
}

const perShare = (value: number | null): string => (value === null ? "—" : usd(value));

export function PositionDetailSheet({
  detail,
  open,
  onOpenChange,
  onSelectAccount,
}: {
  /** Null while nothing is selected — the sheet renders closed rather than unmounting its own state. */
  detail: PositionDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tapping an account line scopes the positions table to it — same destination as /accounts. */
  onSelectAccount?: (accountId: string) => void;
}) {
  if (detail === null) return null;

  const title = detail.symbol ?? detail.description ?? "Position";
  // An untickered 401(k) collective trust has no symbol at all. Saying so plainly is more useful than
  // showing a blank where a ticker would be — it explains why the row can never carry a live quote.
  const untickered = detail.symbol === null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-xl">{title}</SheetTitle>
          {detail.description !== null && detail.symbol !== null && (
            <p className="text-sm text-text-muted">{detail.description}</p>
          )}
        </SheetHeader>

        <div className="px-4 pb-6">
          {/* The headline: value and direction, the same two facts the row showed, so the tap feels
              continuous rather than like a different subject. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-3">
            <Amount value={detail.marketValue} className="text-3xl font-display tabular-nums" />
            <GainText absolute={detail.gain.absolute} percent={detail.gain.percent} />
          </div>

          {/* Per-share — the numbers that make this comparable to a quote. */}
          <div className="mt-3 border-b border-border pb-2">
            <Row label="Shares">{detail.shares}</Row>
            <Row label="Price per share">{perShare(detail.pricePerShare)}</Row>
            <Row label="Cost per share">{perShare(detail.costBasisPerShare)}</Row>
            <Row label="Total cost basis">
              {detail.costBasis === null ? (
                <span className="text-text-muted">unknown</span>
              ) : (
                usd(detail.costBasis)
              )}
            </Row>
          </div>

          {/* How big a bet — concentration made legible at the position, not just in aggregate. */}
          {detail.portfolioShare !== null && (
            <div className="border-b border-border py-2">
              <Row label="Share of portfolio">{(detail.portfolioShare * 100).toFixed(1)}%</Row>
            </div>
          )}

          {/* Where it is held. Only worth a section when it spans accounts — for a single-account
              position the numbers above already say everything, and a one-row table is noise. */}
          {detail.lines.length > 1 && (
            <div className="mt-3">
              <h4 className="text-[10px] uppercase tracking-wide text-text-muted/70">Held in</h4>
              <ul className="mt-2 space-y-1">
                {detail.lines.map((line) => (
                  <li key={line.accountId}>
                    <button
                      type="button"
                      onClick={() => onSelectAccount?.(line.accountId)}
                      disabled={onSelectAccount === undefined}
                      className={cn(
                        "flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left",
                        onSelectAccount !== undefined && "hover:bg-surface-overlay",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-text-primary">{line.accountName}</span>
                        <span className="text-xs text-text-muted">
                          {line.shares ?? "—"} sh
                          {line.costBasis !== null && line.shares !== null && line.shares > 0 && (
                            <> · {usd(line.costBasis / line.shares)}/sh cost</>
                          )}
                          {line.source === "manual" && <> · hand-set</>}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-sm tabular-nums">
                        <span className="block">{usd(line.marketValue)}</span>
                        <span className="text-xs">
                          <GainText absolute={line.gain.absolute} percent={line.gain.percent} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Provenance last: it explains how much to trust everything above. A single-account position
              shows it here, since it has no "Held in" list to carry the label. */}
          {detail.lines.length === 1 && (
            <p className="mt-3 text-xs text-text-muted">
              {detail.lines[0].source === "manual"
                ? "Entered by hand. Not updated on sync."
                : "From your brokerage feed, refreshed on each sync."}
              {detail.lines[0].asOf !== null && <> Last updated {detail.lines[0].asOf.slice(0, 10)}.</>}
            </p>
          )}

          {untickered && (
            <p className="mt-3 text-xs text-text-muted">
              No public ticker. Valued from the account balance.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
