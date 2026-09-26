import type { ColumnDef } from "@tanstack/react-table";
import { createSelectColumn } from "../../components/views/data-table";
import { BrandIcon } from "../../components/brand-icon";
import { Amount } from "../transactions/amount";
import type { AccountItem } from "./account-item";
import { ACCOUNT_TYPE_ICONS, ACCOUNT_TYPE_LABELS, providerLabel } from "./account-types";

/**
 * The accounts table columns. The select column (bulk ops) leads ONLY in manage mode — outside it there
 * are no bulk actions, so a checkbox column would be a dead affordance. Then Name (with a source/
 * institution subline), Type (a friendly icon + label, icon-only on mobile), Balance last so it stays
 * rightmost. There is NO Status column: enabled is the norm and shown invisibly, so only exceptions get a
 * cue — 'discovered' gets a "new" pill on the name (it needs the user's attention), and 'disabled' dims
 * the whole row (applied by the route via rowClassName). Balance goes through the shared <Amount> so it
 * follows the app-wide amount_style setting — the same money rendering transactions use, never a separate
 * currency format. The row is clickable (opens the account's transactions, or the edit drawer in Manage
 * mode).
 */
export function createAccountColumns(manageMode: boolean): ColumnDef<AccountItem>[] {
  return [
    ...(manageMode ? [createSelectColumn<AccountItem>()] : []),
    {
      id: "name",
      accessorKey: "name",
      header: "Account",
      meta: { gridColumn: "minmax(0,1fr)" },
      cell: ({ row }) => {
        const item = row.original;
        // Show the institution (its friendly name, or its domain) — the type icon already conveys what
        // KIND of account this is, so the old "· SimpleFIN" was redundant noise. Manual accounts have no
        // institution, so they fall back to the provider label ("Manual").
        const subline =
          item.institutionName !== null ? item.institutionName : providerLabel(item.provider);
        return (
          // Cap the name column on mobile so the type icon + balance stay on-screen; unconstrained it
          // ate the whole row. From sm up it grows normally.
          <div className="flex min-w-0 max-w-[45vw] items-center gap-2.5 sm:max-w-none">
            {/* The bank's face: its favicon (institution.domain streams from the SimpleFIN org block),
                or a deterministic monogram for manual/domain-less accounts. */}
            <BrandIcon name={subline} domain={item.institutionDomain} className="size-7" />
            <div className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-text-primary">{item.name}</span>
              {/* A discovered account is new and needs opt-in; enabled/disabled show no name cue (disabled
                  dims the whole row instead). This is the ONLY status signal on the default view. */}
              {item.enrollment === "discovered" && (
                <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
                  new
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-text-muted">{subline}</span>
            </div>
          </div>
        );
      },
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => {
        const type = row.original.type;
        const Icon = ACCOUNT_TYPE_ICONS[type];
        const label = ACCOUNT_TYPE_LABELS[type];
        // Icon always; the friendly label ("Credit card", never "credit_card") shows from sm up, so mobile
        // stays icon-only (pill-nav rule). aria-label carries the full name for screen readers regardless.
        return (
          <span
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary"
            aria-label={label}
          >
            <Icon className="size-4 shrink-0" strokeWidth={2} />
            <span className="hidden sm:inline">{label}</span>
          </span>
        );
      },
    },
    // Balance LAST so it is always the rightmost column. Rendered by the shared Amount component: a null
    // balance shows an em dash, otherwise the signed numeric value formatted per the active amount_style.
    {
      id: "balance",
      accessorKey: "balanceValue",
      header: () => <div className="text-right">Balance</div>,
      cell: ({ row }) =>
        row.original.balance === null ? (
          <div className="text-right text-sm text-text-muted">—</div>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            {/* A manually-overridden balance is flagged so an authored figure never silently reads as live. */}
            {row.original.balanceOverridden && (
              <span
                className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500"
                title="Manually set — overrides the synced balance"
              >
                manual
              </span>
            )}
            <Amount value={row.original.balanceValue} className="block text-sm" />
          </div>
        ),
    },
  ];
}
