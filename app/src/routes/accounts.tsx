import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { accountCollection, institutionCollection, institutionLabel, type Account } from "../lib/collections";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { apiPost } from "../lib/api";
import {
  type AccountItem,
  type AccountJoins,
  getAccountRowId,
  toAccountItem,
} from "../features/accounts/account-item";
import { createAccountColumns } from "../features/accounts/columns";
import {
  ACCOUNT_TYPE_LABELS,
  SETTABLE_ACCOUNT_TYPES,
  toAccountType,
  type AccountType,
} from "../features/accounts/account-types";
import {
  DEFAULT_GROUP_BY,
  DEFAULT_SORT,
  buildAccountRegistry,
  searchSchema,
} from "../features/accounts/registry";
import { AccountEditDrawer } from "../features/accounts/account-edit-drawer";
import { AccountBulkCommands } from "../features/accounts/account-bulk-commands";
import {
  DataTable,
  DataTableToolbar,
  FilterProvider,
  parseUrlToViewState,
  serializeViewStateToUrl,
  type ViewState,
} from "../components/views/data-table";

export const Route = createFileRoute("/accounts")({
  component: AccountsPage,
  validateSearch: searchSchema,
});

function AccountsPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  // Unbound navigate for cross-route jumps (row click -> that account's transactions ledger).
  const navigateTo = useNavigate();
  const searchParams = Route.useSearch();

  const { data } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const accounts = (data ?? []) as Account[];

  const { data: institutionData } = useLiveQuery((q) =>
    q.from({ institutionCollection }).select(({ institutionCollection }) => institutionCollection),
  );

  // Map institution id -> display label ("Chase" / "www.chase.com" instead of the useless "SimpleFIN"),
  // via the one shared institutionLabel projection.
  const joins = useMemo<AccountJoins>(() => {
    const institutionNameById = new Map<string, string>();
    const institutionDomainById = new Map<string, string>();
    for (const institution of institutionData ?? []) {
      institutionNameById.set(institution.id, institutionLabel(institution));
      if (institution.domain !== null && institution.domain.length > 0) {
        institutionDomainById.set(institution.id, institution.domain);
      }
    }
    return { institutionNameById, institutionDomainById };
  }, [institutionData]);

  const items = useMemo<AccountItem[]>(
    () => accounts.map((account) => toAccountItem(account, joins)),
    [accounts, joins],
  );

  const { registry, sortDefinitions, searchFields } = useMemo(
    () => buildAccountRegistry(items),
    [items],
  );

  const viewState = useMemo(
    () =>
      parseUrlToViewState<AccountItem, string>(
        searchParams as Record<string, string | number | undefined>,
        registry,
        DEFAULT_SORT,
        DEFAULT_GROUP_BY,
      ),
    [searchParams, registry],
  );

  const handleViewStateChange = useCallback(
    (next: ViewState<string>) => {
      const params = serializeViewStateToUrl(next, registry, DEFAULT_SORT, DEFAULT_GROUP_BY);
      navigate({ search: params as Record<string, string>, replace: true });
    },
    [navigate, registry],
  );

  const [editing, setEditing] = useState<Account | null>(null);

  // Manage mode is UI-only ephemeral state. OFF (default): a row click opens that account's transactions,
  // and no selection/bulk affordances show. ON: a row click opens the edit drawer and the selection
  // checkboxes + bulk bar appear (gated by passing renderSelectionSurface only in manage mode).
  const [manageMode, setManageMode] = useState(false);

  // The select (checkbox) column is present only in manage mode, so recompute columns when it toggles.
  const columns = useMemo(() => createAccountColumns(manageMode), [manageMode]);

  // Dialog open state for the on-demand Connect / Add-account forms (no longer always-open panels).
  const [connectOpen, setConnectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const openAccount = useCallback(
    (item: AccountItem) => {
      // Investment/stock_plan accounts open their POSITIONS (their transactions are hidden from the
      // ledger and their real content is holdings or grants); everything else opens its transactions
      // ledger.
      if (item.type === "investment" || item.type === "stock_plan") {
        navigateTo({ to: "/holdings", search: { account: item.id } });
      } else {
        navigateTo({ to: "/transactions", search: { account: item.id } });
      }
    },
    [navigateTo],
  );

  const handleRowClick = useCallback(
    (item: AccountItem) => {
      if (manageMode) setEditing(item.account);
      else openAccount(item);
    },
    [manageMode, openAccount],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-3xl tracking-tight">Accounts</h2>
        <div className="flex flex-wrap items-center gap-2">
          <SyncButton />
          {manageMode && (
            <>
              <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                Connect
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                Add account
              </Button>
            </>
          )}
          <Button
            variant={manageMode ? "default" : "outline"}
            size="sm"
            onClick={() => setManageMode((on) => !on)}
          >
            {manageMode ? "Done" : "Manage accounts"}
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
          No accounts yet. Add one from <span className="font-medium">Manage accounts</span>.
        </div>
      ) : (
        <FilterProvider<AccountItem, string>
          items={items}
          registry={registry}
          sortDefinitions={sortDefinitions}
          defaultSort={DEFAULT_SORT}
          defaultGroupBy={DEFAULT_GROUP_BY}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          searchFields={searchFields}
        >
          <DataTable
            columns={columns}
            getRowId={getAccountRowId}
            onRowClick={handleRowClick}
            // Only exceptions are marked: a disabled account dims (it's intentionally inactive); enabled and
            // discovered keep full opacity (discovered carries its own "new" cue on the name).
            rowClassName={(item) => (item.enrollment === "disabled" ? "opacity-45" : undefined)}
            // Selection is wired UNCONDITIONALLY (like transactions) so long-press-to-select works on
            // every row, not just in manage mode — passing renderSelectionSurface is what arms the shared
            // long-press machine (data-table gates on it being defined). Manage mode still changes the
            // tap behavior (edit drawer vs open transactions) via handleRowClick; long-press selects in both.
            renderSelectionSurface={({ selectedRows, clearSelection, closeCommand }) => ({
              commandBody: (
                <AccountBulkCommands
                  selected={selectedRows}
                  clearSelection={clearSelection}
                  closeCommand={closeCommand}
                />
              ),
            })}
            toolbar={<DataTableToolbar />}
          />
        </FilterProvider>
      )}

      <AccountEditDrawer
        account={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/** Pull every enabled connected account, then reconcile links, in one tap. New rows stream in via Electric
 *  (no manual refetch). Reports how many accounts synced / failed; a failed bank surfaces its message so the
 *  user knows which connection needs attention. */
function SyncButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const sync = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const summary = await apiPost<{ synced: number; failed: number }>("sync", {});
      setNote(
        summary.failed > 0
          ? `Synced ${summary.synced}, ${summary.failed} failed`
          : summary.synced === 0
            ? "Nothing to sync"
            : `Synced ${summary.synced} account${summary.synced === 1 ? "" : "s"}`,
      );
    } catch (cause) {
      setNote(`Sync failed: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex items-center gap-2">
      {note !== null && <span className="text-xs text-text-muted">{note}</span>}
      <Button variant="outline" size="sm" onClick={() => void sync()} disabled={busy}>
        <RefreshCw className={cn("size-4", busy && "animate-spin")} />
        {busy ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );
}

/** Paste a base64 SimpleFIN setup token to claim a connection and discover its accounts. The discovered
 *  accounts stream in via Electric as 'discovered' — none are auto-enabled. */
/** Default the backfill picker to one year back — a sensible history window that fills the budget/ledger
 *  on first sync without asking the user to reason about dates. YYYY-MM-DD for an <input type="date">. */
function oneYearAgoDate(): string {
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return oneYearAgo.toISOString().slice(0, 10);
}

function ConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [token, setToken] = useState("");
  // Backfill-from date (YYYY-MM-DD). Threaded to the bridge as ?start-date=<unix seconds> so the first
  // pull loads history, not just the bridge's minimal recent window. Empty = let the server default.
  const [backfillDate, setBackfillDate] = useState(oneYearAgoDate);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (token.trim().length === 0) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      // Convert the picked local date to unix SECONDS (SimpleFIN's start-date unit). Omit when cleared.
      const startDate =
        backfillDate.length > 0 ? Math.floor(new Date(backfillDate).getTime() / 1000) : undefined;
      const summary = await apiPost<{ discovered: number }>("connections/claim", {
        setup_token: token.trim(),
        ...(startDate !== undefined ? { start_date: startDate } : {}),
      });
      setMessage(`Found ${summary.discovered} account(s). Enable the ones you want.`);
      setToken("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a provider</DialogTitle>
          <DialogDescription>
            Paste your SimpleFIN setup token.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="base64 setup token"
            className="font-mono text-xs"
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Backfill history from</span>
            <Input
              type="date"
              value={backfillDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setBackfillDate(event.target.value)}
            />
            <span className="text-xs text-text-muted">
              Defaults to one year ago.
            </span>
          </label>
          <Button onClick={connect} disabled={busy || token.trim().length === 0}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
        {message !== null && <p className="text-xs text-text-secondary">{message}</p>}
        {error !== null && (
          <p className="rounded-md bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Add a manual (non-connected) account. It is created enabled — manual accounts are active at once. */
function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");

  function add() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const now = new Date().toISOString();
    // `class` and `on_budget` are intentionally omitted: the server derives them from `type`
    // (deriveClass/deriveOnBudget) and Electric streams them back. The browser never authors them (R8/R2).
    accountCollection.insert({
      id: crypto.randomUUID(),
      sfin_account_id: null,
      institution_id: null,
      connection_id: null,
      name: trimmed,
      type,
      enrollment: "enabled",
      currency: "USD",
      balance: "0.00",
      balance_override: null,
      available_balance: null,
      balance_date: null,
      sync_status: "ok",
      last_synced_at: null,
      last_success_at: null,
      created_at: now,
      updated_at: now,
    });
    setName("");
    setType("checking");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a manual account</DialogTitle>
          <DialogDescription>Cash, an old card, anything without a feed.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Account name"
          />
          <select
            value={type}
            onChange={(event) => setType(toAccountType(event.target.value))}
            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
          >
            {SETTABLE_ACCOUNT_TYPES.map((option) => (
              <option key={option} value={option}>
                {ACCOUNT_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
          <Button onClick={add} disabled={name.trim().length === 0}>
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
