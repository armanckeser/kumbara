// One inbox QUESTION on the timeline (Pitch 16, grouped per inbox-questions.ts), built for recognize-then-
// recall:
//   - at a glance: an icon for the kind of business, the merchant (×N when one answer covers several
//     charges), the amount, and ONE filled chip — the app’s best answer. One tap settles.
//   - when the merchant isn't recognized, tapping the row opens the rest in place: the other answers, the
//     place, the other charges that day, and a web search for the raw descriptor.
// The left rail carries the day label (once per day) and the trip band, so neither is repeated as text on
// every row. The closed answer list is still Categorize… / Transfer / Refund (+ the paycheck variant).
//
// This row holds ZERO decision logic (R2): it renders already-derived state (chips ranked by the server,
// cues from /api/inbox/context) and calls injected handlers that POST to the server.

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  BedDouble,
  Check,
  Clapperboard,
  Coffee,
  Fuel,
  Landmark,
  MapPin,
  Pill,
  Plane,
  Repeat,
  Search,
  ShoppingBag,
  ShoppingCart,
  TrainFront,
  Undo2,
  User,
  Utensils,
  Zap,
} from "lucide-react";
import type { BusinessKind, InboxContext } from "../../../domain/inbox-context";
import { cn } from "@/lib/utils";
import { Amount } from "./amount";
import { StateBadge } from "./state-badge";
import { cardChips } from "./inbox-chips";
import type { TransactionGroupItem } from "./group-item";
import { type InboxQuestion, matchRationale } from "./inbox-questions";
import type { TimelineEntry } from "./inbox-timeline";
import { descriptorSearchUrl } from "./lookup";
import type { TriageChip } from "./use-triage";
import { brandDomain } from "../brands/brand-domains";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const KIND_ICONS: Record<BusinessKind, LucideIcon> = {
  person: User,
  coffee: Coffee,
  dining: Utensils,
  groceries: ShoppingCart,
  bills: Zap,
  fuel: Fuel,
  lodging: BedDouble,
  health: Pill,
  travel: Plane,
  transit: TrainFront,
  entertainment: Clapperboard,
  shopping: ShoppingBag,
};

/** The merchant's logo — its site's favicon (Google's s2 service, by domain) on a white tile, the way most
 *  favicons are drawn to be seen. Calls `onFail` when there is none, so the caller falls back. */
function Logo({ domain, className, onFail }: { domain: string; className: string; onFail: () => void }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-white", className)}>
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`}
        alt=""
        aria-hidden
        onError={onFail}
        // s2 answers an unknown domain with a 16px globe instead of an error; treat that as no logo.
        onLoad={(event) => {
          if (event.currentTarget.naturalWidth <= 16) onFail();
        }}
        className="size-full object-contain"
      />
    </span>
  );
}

/** The row's face: what kind of thing this is, before any word is read. A merchant with a known website
 *  shows its logo; otherwise a link candidate shows its question (transfer / refund), a paycheck a bank, a
 *  merchant its business kind, else its initial. */
function RowIcon({ domain, icon, initial }: { domain: string | null; icon: LucideIcon | null; initial: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (domain !== null && failed !== domain) {
    return <Logo domain={domain} className="size-[42px] rounded-[13px] p-1.5" onFail={() => setFailed(domain)} />;
  }
  const Icon = icon;
  return (
    <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[13px] bg-surface-overlay/70 text-text-primary">
      {Icon !== null ? (
        <Icon className="size-5 opacity-90" strokeWidth={1.75} aria-hidden />
      ) : (
        <span className="text-base font-semibold">{initial}</span>
      )}
    </span>
  );
}

/** A same-day charge's small face: its logo, else its business-kind icon, else its initial. */
function ChargeFace({ domain, icon, initial }: { domain: string | null; icon: LucideIcon | null; initial: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (domain !== null && failed !== domain) {
    return <Logo domain={domain} className="size-5 rounded-full p-0.5" onFail={() => setFailed(domain)} />;
  }
  const Icon = icon;
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-surface-overlay">
      {Icon !== null ? (
        <Icon className="size-3 text-text-primary" aria-hidden />
      ) : (
        <span className="text-[10px] font-semibold text-text-primary">{initial}</span>
      )}
    </span>
  );
}

/** A pill answer. The one `primary` chip per row is the app's best guess; the rest are quiet. */
function Chip({
  primary = false,
  icon: Icon,
  label,
  onClick,
  ariaLabel,
}: {
  primary?: boolean;
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={ariaLabel ?? label}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] transition-[transform,background-color] duration-150 ease-(--ease-out) active:scale-[0.97] pointer-coarse:h-10",
        primary
          ? "border-primary/35 bg-primary/12 font-medium text-primary"
          : "border-border bg-surface-raised text-text-secondary hover:text-text-primary",
      )}
    >
      {primary && <Check className="size-3.5" strokeWidth={2.6} aria-hidden />}
      {!primary && Icon !== undefined && <Icon className="size-3.5 opacity-70" aria-hidden />}
      {label}
    </button>
  );
}

/** A stacked leg inside a link candidate's open panel, so "yes, these are the same movement" is checkable
 *  in place. The counterparty names its payee — "a $98.08 Amazon purchase" is answerable. */
function Leg({
  label,
  payee,
  accountName,
  amountValue,
  date,
  state,
}: {
  label: string;
  payee?: string;
  accountName: string;
  amountValue: number;
  date: string;
  state: TransactionGroupItem["state"];
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-text-muted">{label}</span>
        {payee !== undefined && <span className="truncate text-text-secondary">{payee}</span>}
        <span className="truncate text-text-secondary">{accountName}</span>
        <StateBadge state={state} />
      </div>
      <div className="flex shrink-0 items-center gap-2 tabular-nums text-text-muted">
        <span>{date.slice(5, 10)}</span>
        <span className="font-medium text-text-primary">{USD.format(amountValue)}</span>
      </div>
    </div>
  );
}

interface Answer {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly ariaLabel?: string;
  readonly run: () => void;
}

export function InboxRow({
  question,
  entry,
  context,
  recurringHint,
  candidates,
  error,
  open,
  onToggle,
  onCategorize,
  onPickCategory,
  onTransfer,
  onRefund,
  onOpenDetail,
  onAcceptPaycheck,
}: {
  question: InboxQuestion;
  /** Where the row sits on the timeline (day label, trip band). */
  entry: TimelineEntry<InboxQuestion>;
  /** The server's recall cues; absent until fetched (the row then shows its initial and no place). */
  context?: InboxContext;
  /** A "Recurring · $10.99 /mo" hint when this merchant has a detected recurring series. */
  recurringHint?: string | null;
  /** The question's ranked category chips (Pitch 19), server-ordered. */
  candidates?: readonly TriageChip[];
  /** A failed write to surface ON the row (it came back after an optimistic hide), or null. */
  error?: string | null;
  /** The row's recall panel is open. */
  open: boolean;
  onToggle: () => void;
  /** Open the full category picker for the long tail / "none fit". */
  onCategorize: () => void;
  /** One-tap categorize from a chip: write the chosen category for the cohort's ids. */
  onPickCategory: (categoryId: string, categoryName: string) => void;
  /** "It's a transfer" — one-taps the known link OR opens the follow-up sheet (Pitch 20). */
  onTransfer: () => void;
  /** "It's a refund" — same routing as onTransfer. */
  onRefund: () => void;
  /** The full detail sheet (history legs, notes). */
  onOpenDetail: () => void;
  /** Accept a diverged paycheck's amounts for this period (Pitch 38). */
  onAcceptPaycheck?: () => void;
}) {
  const item = question.representative;
  const count = question.items.length;
  const suggestion = item.suggestion;
  const counterparty = suggestion?.counterparty ?? null;
  const isPaycheck = item.paycheckStatus === "diverged" && item.paycheck !== null;

  // The best answer is the one filled chip; the rest wait behind a tap on the row.
  const { chips, hasMore } = cardChips(candidates ?? []);
  const categorize: Answer = { label: "Categorize…", ariaLabel: "Categorize this", run: onCategorize };
  const transfer: Answer = {
    label: "Transfer",
    icon: ArrowLeftRight,
    ariaLabel: "It's a transfer — moving my own money",
    run: onTransfer,
  };
  const refund: Answer = { label: "Refund", icon: Undo2, ariaLabel: "It's a refund", run: onRefund };

  let guess: Answer | null;
  let others: Answer[];
  let icon: LucideIcon | null;
  if (isPaycheck) {
    guess = { label: "Accept this period", run: onAcceptPaycheck ?? onOpenDetail };
    others = [{ label: "Review breakdown", run: onOpenDetail }];
    icon = Landmark;
  } else if (suggestion?.kind === "transfer") {
    guess = transfer;
    others = [categorize, refund];
    icon = ArrowLeftRight;
  } else if (suggestion?.kind === "refund") {
    guess = refund;
    others = [categorize, transfer];
    icon = Undo2;
  } else if (suggestion?.kind === "reimbursement") {
    guess = { ...categorize, label: "Categorize…" };
    others = [transfer, refund];
    icon = context?.kind != null ? KIND_ICONS[context.kind] : User;
  } else {
    const [top, ...rest] = chips;
    guess =
      top === undefined
        ? null
        : {
            label: top.category_name,
            ariaLabel: `Categorize as ${top.category_name}`,
            run: () => onPickCategory(top.category_id, top.category_name),
          };
    others = [
      ...rest.map((chip) => ({
        label: chip.category_name,
        ariaLabel: `Categorize as ${chip.category_name}`,
        run: () => onPickCategory(chip.category_id, chip.category_name),
      })),
      ...(top === undefined || hasMore ? [{ ...categorize, label: top === undefined ? "Categorize…" : "More…" }] : []),
      transfer,
      refund,
    ];
    icon = context?.kind != null ? KIND_ICONS[context.kind] : null;
  }

  const sameDay = context?.same_day ?? [];
  // A merchant question shows its logo when its website is known (looked up, or a well-known brand); a
  // transfer/refund/paycheck keeps the icon that names its question.
  const logoDomain =
    suggestion === null && !isPaycheck ? (context?.domain ?? brandDomain(item.payee)) : null;
  const place = context?.place ?? null;

  return (
    <li className="flex">
      {/* The rail: the day once per day, and a band joining the questions of one trip. */}
      <div className="relative flex w-14 shrink-0 flex-col items-center pt-3" aria-hidden={!entry.showDay}>
        {entry.trip !== null && (
          <span
            className={cn(
              "absolute bottom-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-border",
              entry.tripStart ? "top-3" : "top-0",
            )}
          />
        )}
        {entry.showDay && (
          <span className={cn("relative flex flex-col items-center py-0.5", entry.trip !== null && "bg-surface")}>
            <span className="text-[10px] font-semibold tracking-[0.06em] text-text-muted">{entry.weekday}</span>
            <span className="text-[17px] font-semibold leading-tight tracking-tight text-text-primary">
              {entry.dayOfMonth}
            </span>
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 border-b border-border-subtle pt-2.5 pb-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-3 text-left"
        >
          <RowIcon domain={logoDomain} icon={icon} initial={item.payee.trim().slice(0, 1).toUpperCase()} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[15.5px] font-medium tracking-[-0.01em] text-text-primary">
                  {item.payee}
                </span>
                {/* A cohort is one answer for several charges; the amount is their total. */}
                {count > 1 && (
                  <span className="shrink-0 font-mono text-[13px] text-text-secondary" aria-label={`${count} charges`}>
                    ×{count}
                  </span>
                )}
                {recurringHint != null && (
                  <Repeat className="size-3.5 shrink-0 text-text-muted" aria-label={recurringHint} />
                )}
              </span>
              <Amount
                value={count > 1 ? question.totalAmount : item.amountValue}
                className="shrink-0 font-mono text-sm font-medium"
              />
            </span>
          </span>
        </button>

        <div className="flex flex-wrap gap-1.5 pt-2.5 pl-[54px]">
          {guess !== null ? (
            <Chip primary label={guess.label} ariaLabel={guess.ariaLabel} onClick={guess.run} />
          ) : (
            <Chip label="Categorize…" ariaLabel="Categorize this" onClick={onCategorize} />
          )}
          {open &&
            others.map((answer) => (
              <Chip
                key={answer.label}
                icon={answer.icon}
                label={answer.label}
                ariaLabel={answer.ariaLabel}
                onClick={answer.run}
              />
            ))}
        </div>

        {open && (
          <div className="mt-3 flex flex-col gap-2.5 pl-[54px]">
            {isPaycheck && item.paycheck !== null && (
              <p className="text-[13px] text-text-secondary">
                Landed {USD.format(item.paycheck.actualNet)} · expected {USD.format(item.paycheck.expectedNet)}
              </p>
            )}

            {suggestion !== null && (
              <div className="flex flex-col gap-1">
                <Leg
                  label="This"
                  accountName={item.accountName}
                  amountValue={item.amountValue}
                  date={item.date}
                  state={item.state}
                />
                {counterparty !== null && (
                  <>
                    <Leg
                      label="Other"
                      payee={counterparty.payee}
                      accountName={counterparty.accountName}
                      amountValue={counterparty.amountValue}
                      date={counterparty.date}
                      state="Posted"
                    />
                    <p className="px-0.5 text-xs text-text-muted">
                      {matchRationale(suggestion.kind, item, counterparty)}
                    </p>
                  </>
                )}
              </div>
            )}

            {(place !== null || sameDay.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {place !== null && (
                  <span className="inline-flex h-7 items-center gap-1 pr-1 text-[12.5px] text-text-secondary">
                    <MapPin className="size-3.5 text-text-muted" aria-hidden />
                    {place}
                  </span>
                )}
                {sameDay.map((charge, index) => {
                  return (
                    <span
                      key={index}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-subtle bg-surface-raised pr-2.5 pl-1 text-[12.5px] text-text-secondary"
                    >
                      <ChargeFace
                        domain={charge.domain ?? brandDomain(charge.payee)}
                        icon={charge.kind !== null ? KIND_ICONS[charge.kind] : null}
                        initial={charge.payee.slice(0, 1).toUpperCase()}
                      />
                      <span className="max-w-28 truncate">{charge.payee}</span>
                      <span className="font-mono text-text-muted">{USD.format(charge.amount)}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-4 text-[13px]">
              <a
                href={descriptorSearchUrl(item.description_raw)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-primary"
              >
                <Search className="size-3.5" aria-hidden />
                Search the web
              </a>
              <button type="button" onClick={onOpenDetail} className="text-text-secondary hover:text-text-primary">
                Details
              </button>
            </div>
          </div>
        )}

        {/* A failed write surfaces HERE, on the row it failed for — never a silent no-op. */}
        {error != null && <p className="mt-2 pl-[54px] text-xs text-danger">Couldn’t save — {error}</p>}
      </div>
    </li>
  );
}
