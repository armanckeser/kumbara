// Set up a deposit as a paycheck (Pitch 38) — the ONE time per payer the user has to say it.
//
// Opened from a deposit's detail sheet ("Set up as paycheck"). The user picks an income source; POSTing
// paychecks/generate turns the deposit's net into the 401k/transit/tax synthetic legs its rules imply
// (server-side, R2) AND, when the source isn't linked to a payer yet, links it to this deposit's payer — so
// every later deposit from the same payer is broken down automatically after each sync, with no tap. If no
// income source exists yet, we point the user at the budget page's Paychecks manager to set one up.

import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { apiPost } from "../../lib/api";
import { incomeSourceCollection, type IncomeSource } from "../../lib/collections";
import { payCadenceLabel } from "../../../domain/paycheck";

/** The deposit a paycheck is generated for — the caller (detail sheet) supplies its primary id. */
export interface GeneratePaycheckTarget {
  readonly primaryTxnId: string;
}

export function GeneratePaycheckSheet({
  target,
  open,
  onOpenChange,
  onGenerated,
}: {
  target: GeneratePaycheckTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-md">
        {target !== null && <GeneratePaycheckBody key={target.primaryTxnId} target={target} onGenerated={onGenerated} />}
      </SheetContent>
    </Sheet>
  );
}

function GeneratePaycheckBody({
  target,
  onGenerated,
}: {
  target: GeneratePaycheckTarget;
  onGenerated: () => void;
}) {
  const { data: sourceData } = useLiveQuery((q) =>
    q.from({ incomeSourceCollection }).select(({ incomeSourceCollection }) => incomeSourceCollection),
  );
  const sources = useMemo(
    () => ((sourceData ?? []) as IncomeSource[]).filter((source) => source.status === "active"),
    [sourceData],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    if (selectedId === null) {
      setError("Pick a paycheck.");
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await apiPost<{ txid: number; leg_count: number }>("paychecks/generate", {
          income_source_id: selectedId,
          primary_txn_id: target.primaryTxnId,
        });
        onGenerated();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex h-full flex-col gap-5 p-6">
      <SheetHeader className="p-0">
        <SheetTitle className="text-xl">Set up as paycheck</SheetTitle>
        <SheetDescription className="text-xs text-text-muted">
          Splits this deposit into gross, deductions and taxes. Later deposits from this payer are split
          automatically.
        </SheetDescription>
      </SheetHeader>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
          No paychecks yet. Add one in Budget → Paychecks.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                onClick={() => setSelectedId(source.id)}
                className={
                  "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm " +
                  (selectedId === source.id ? "border-primary bg-surface-raised/60" : "border-border")
                }
              >
                <span className="text-text-primary">{source.name}</span>
                <span className="text-xs text-text-muted">
                  {source.merchant_key === null ? "not linked to a payer yet" : payCadenceLabel[source.cadence]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && <p className="text-xs text-danger">{error}</p>}

      {sources.length > 0 && (
        <div className="mt-auto">
          <Button className="w-full" disabled={busy || selectedId === null} onClick={generate}>
            Set up paycheck
          </Button>
        </div>
      )}
    </div>
  );
}
