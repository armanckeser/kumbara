// anonymize.ts — turn reviewed REAL feed output into SYNTHETIC fixtures.
//
// ⚠️  RUN ONLY BY THE USER. THE CODING AGENT NEVER EXECUTES THIS, NEVER READS .real-output/, AND NEVER
//     READS .anonymize-staging/.  ⚠️
//
// This is the safe bridge in the two-layer design: it carries LEARNINGS (the shape of a tricky
// reconciliation case) from the real layer to the synthetic layer the coding agent works in, while
// destroying the underlying PII. The user runs it, reviews the staged fixtures, and only then promotes
// approved ones into server/features/ingestion/fixtures/ where the agent may finally see them.
//
// What it preserves (the learning): the pending/posted pairing structure, relative date shifts, the
// presence of a tip band, the rough amount magnitude. What it destroys (the data): real merchant names,
// account ids, exact amounts, exact dates, transaction ids.
//
// Usage (user, from app/):
//   npx tsx tools/anonymize.ts
//
// It reads server/features/ingestion/.real-output/*.json and writes tools/.anonymize-staging/*.json.
// Both directories are gitignored. Plain Node fs (this is the user's local tool, not part of the agent
// runtime), kept dependency-free on purpose.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The value transforms are shared with the in-place DB anonymizer (R8: one definition of "real -> fake").
// Only the FILE I/O below is user-only (R9); the transforms are pure and identical on both paths.
import {
  SYNTHETIC_EPOCH_SECONDS,
  syntheticAmount,
  syntheticMerchantName,
  syntheticTimestamp,
} from "../domain/synthetic.ts";

const here = dirname(fileURLToPath(import.meta.url));
const realOutputDir = join(here, "..", "server", "features", "ingestion", ".real-output");
const stagingDir = join(here, ".anonymize-staging");

interface RealTxn {
  readonly id?: string;
  readonly posted: number;
  readonly amount: string;
  readonly description: string;
  readonly payee?: string;
  readonly pending?: boolean;
}

const anonymizeFile = (fileName: string): void => {
  const raw = JSON.parse(readFileSync(join(realOutputDir, fileName), "utf8")) as {
    readonly transactions?: ReadonlyArray<RealTxn>;
  };
  const transactions = raw.transactions ?? [];
  const base = transactions.length > 0 ? transactions[0].posted : SYNTHETIC_EPOCH_SECONDS;

  const sanitized = transactions.map((txn, index) => {
    const merchant = syntheticMerchantName(txn.payee ?? txn.description);
    return {
      id: `TRN-synthetic-${index}`,
      posted: syntheticTimestamp(txn.posted, base),
      amount: syntheticAmount(txn.amount),
      description: merchant,
      payee: merchant,
      ...(txn.pending === true ? { pending: true } : {}),
    };
  });

  mkdirSync(stagingDir, { recursive: true });
  const outputFile = join(stagingDir, `synthetic-${fileName}`);
  writeFileSync(
    outputFile,
    JSON.stringify(
      {
        account: { sfin_account_id: "ACT-synthetic", name: "Synthetic Account", type: "checking" },
        batches: { posted: sanitized },
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${outputFile} (${sanitized.length} synthetic txns)`);
};

const files = readdirSync(realOutputDir).filter((name) => name.endsWith(".json"));
if (files.length === 0) {
  console.error(`no .json files in ${realOutputDir}; run real-run.ts first (as the user)`);
  process.exit(1);
}
for (const file of files) anonymizeFile(file);
console.log(`\nReview ${stagingDir}, then copy approved fixtures into server/features/ingestion/fixtures/`);
