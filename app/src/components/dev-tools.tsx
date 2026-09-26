import { useState } from "react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { apiPost } from "@/lib/api";

/**
 * Local-only developer toolbox, modeled on TanStack's dev toolbar: a floating wrench FAB (bottom-left,
 * clear of the center pill-nav and the right-side SelectionFab) that opens a small list of dev actions.
 *
 * Gated on `import.meta.env.DEV` — statically `false` under `vite build`, so this whole component (and the
 * `apiPost` triggers it carries) is dead-code-eliminated from the shipped bundle. These were inline header
 * buttons on the transactions/accounts pages; consolidating them here declutters the real UI. (R0: this is
 * a local personal tool — the gate is convenience, not a trust boundary.)
 */

interface DevAction {
  readonly label: string;
  readonly busyLabel: string;
  /** Optional confirmation copy; when set the action prompts before running (destructive ops). */
  readonly confirm?: string;
  /** Triggers the server-side op and returns a result message to surface, or null for a silent success. */
  readonly run: () => Promise<string | null>;
}

// One registry, N actions: adding a dev action is a single entry, never new JSX (mirrors pill-nav's
// DESTINATIONS). Every action POSTs to an existing synthetic/fixture endpoint — the FixtureSource ingest
// and the in-place anonymizer — never the real SimpleFIN feed (R9). All logic stays server-side (R2);
// these are thin triggers.
const DEV_ACTIONS: ReadonlyArray<DevAction> = [
  {
    // Replay the synthetic fixture's pending batch, then the posted batch, and watch reconciliation
    // collapse the pending legs into their posted groups live via Electric.
    label: "Ingest pending",
    busyLabel: "Ingesting…",
    run: async () => {
      await apiPost("ingest/run", { fixture: "pending-then-posted-dateshift", batch: "pending" });
      return null;
    },
  },
  {
    label: "Ingest posted",
    busyLabel: "Ingesting…",
    run: async () => {
      await apiPost("ingest/run", { fixture: "pending-then-posted-dateshift", batch: "posted" });
      return null;
    },
  },
  {
    // In-place real-shape/fake-value pass so the coding agent works against real structure without real
    // values. The faking is entirely server-side; this only POSTs the trigger.
    label: "Anonymize data",
    busyLabel: "Anonymizing…",
    confirm:
      "Replace ALL real values with synthetic ones?\n\n" +
      "Amounts, names, payees and dates will be overwritten in place. This cannot be undone — " +
      "recovery is re-pulling from SimpleFIN. Structure (categories, types, splits) is kept.",
    run: async () => {
      const summary = await apiPost<{ transactions: number; accounts: number }>("anonymize", {});
      return `Anonymized ${summary.transactions} transaction(s), ${summary.accounts} account(s).`;
    },
  },
];

export function DevTools() {
  if (!import.meta.env.DEV) return null;
  return <DevToolsPanel />;
}

function DevToolsPanel() {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function trigger(action: DevAction) {
    if (action.confirm !== undefined && !window.confirm(action.confirm)) return;
    setBusyLabel(action.label);
    setMessage(null);
    try {
      const result = await action.run();
      if (result !== null) setMessage(result);
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusyLabel(null);
    }
  }

  return (
    // Bottom-LEFT so it never stacks with the pill-nav (center, z-50) or the SelectionFab (right, z-40).
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-40">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="icon"
              variant="secondary"
              className="size-11 rounded-full shadow-lg"
              aria-label="Developer tools"
            />
          }
        >
          <Wrench className="size-5" strokeWidth={2} />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-60 p-2">
          <p className="px-2 pb-1.5 text-xs font-medium text-text-muted">Dev tools</p>
          <div className="flex flex-col gap-1">
            {DEV_ACTIONS.map((action) => (
              <Button
                key={action.label}
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={busyLabel !== null}
                onClick={() => trigger(action)}
              >
                {busyLabel === action.label ? action.busyLabel : action.label}
              </Button>
            ))}
          </div>
          {message !== null && (
            <p className="mt-2 px-2 text-xs break-words text-text-muted">{message}</p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
