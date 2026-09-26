// AnonymizeStore — the in-place DB rewrite that turns REAL values into SYNTHETIC ones.
//
// This is the engine behind the app's "Anonymize" button. The user onboards their real SimpleFIN data,
// uses the app for real, then presses Anonymize BEFORE talking to the coding agent. This store rewrites
// every PII column in place — destructively, irreversibly — so that afterwards there is exactly ONE set
// of values everywhere (DB, API, frontend, screenshots), all synthetic. Recovery is re-pulling from
// SimpleFIN; nothing real is dumped to disk.
//
// What is FAKED: amounts, payees/descriptions, dates, account/institution/person names, the connection
// secret. What is KEPT (structure, the whole point — the agent works against real shape): category_id,
// bucket, account type, person_id linkage, status + supersede chains, every FK, and the merchant
// equivalence classes (rows that shared a merchant_key still do).
//
// The value transforms live in domain/synthetic.ts (shared with the user-only fixture tool, R8); this
// store is only the SQL that applies them. It is the in-place twin of IngestStore: same withTransaction
// + currentTxid idiom, same ::text-cast reads.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountId, MerchantKey } from "../../../domain/common";
import {
  syntheticAmount,
  syntheticDayOffsetIso,
  syntheticMerchantKey,
  syntheticMerchantName,
} from "../../../domain/synthetic";
import { importHash } from "../ingestion/import-hash";

const decodeAccountId = Schema.decodeUnknownSync(AccountId);
const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

/** A write result carries the txid Electric will echo, so an optimistic client mutation could settle.
 *  The Anonymize button doesn't go through the optimistic path, but the txid keeps house style. */
export interface AnonymizeResult {
  readonly txid: number;
  readonly transactions: number;
  readonly accounts: number;
  readonly merchants: number;
}

interface MerchantRow {
  readonly id: string;
  readonly merchant_key: string;
  readonly canonical_name: string;
}

interface TransactionRow {
  readonly id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly merchant_key: string | null;
  readonly posted_at: string | null;
  readonly transacted_at: string | null;
}

interface AccountRow {
  readonly id: string;
  readonly balance: string | null;
  readonly available_balance: string | null;
}

export class AnonymizeStore extends Context.Service<AnonymizeStore>()(
  "kumbara/anonymize/AnonymizeStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      const currentTxid = Effect.fn("AnonymizeStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /**
       * Rewrite every PII value in the database with a synthetic one, in place, inside one transaction.
       * Order is FK-safe and merchant-first so the real->synthetic key map is built once and reused for
       * both the merchant rows and the transaction rows (keeping their equivalence classes aligned).
       */
      const anonymizeAll = Effect.fn("AnonymizeStore.anonymizeAll")(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();

            // ---- merchant: rewrite merchant_key (stable 1:1) + canonical_name, drop logo ----
            // The map from a real key to its synthetic key is the SINGLE source of equivalence-class
            // preservation: every consumer of a real key (merchant rows + transaction rows) maps the
            // same way, so groupings are intact and distinct keys stay distinct (UNIQUE holds).
            const merchants = yield* sql<MerchantRow>`
              SELECT id, merchant_key, canonical_name FROM merchant
            `;
            const keyMap = new Map<string, MerchantKey>();
            for (const merchant of merchants) {
              if (!keyMap.has(merchant.merchant_key)) {
                keyMap.set(merchant.merchant_key, syntheticMerchantKey(merchant.merchant_key));
              }
            }
            for (const merchant of merchants) {
              const newKey = keyMap.get(merchant.merchant_key) ?? syntheticMerchantKey(merchant.merchant_key);
              yield* sql`
                UPDATE merchant SET
                  merchant_key   = ${newKey},
                  canonical_name = ${syntheticMerchantName(merchant.canonical_name)},
                  logo           = NULL
                WHERE id = ${merchant.id}
              `;
            }

            // ---- transaction: fake amount/payees/dates/key, RECOMPUTE import_hash ----
            // import_hash = sha256(account_id | round(abs(amount)) | merchant_key). Faking amount + key
            // makes the stored hash stale; recomputing it here (with the SAME importHash() the ingest
            // path uses) is what keeps the next real ingest's dedup from silently breaking.
            const rows = yield* sql<TransactionRow>`
              SELECT id, account_id, amount::text AS amount, merchant_key,
                     posted_at::text AS posted_at, transacted_at::text AS transacted_at
              FROM transaction
            `;
            // Per-account earliest posted_at is the date base, so each account's relative day-offsets are
            // preserved against a stable anchor.
            const baseByAccount = new Map<string, string>();
            for (const row of rows) {
              if (row.posted_at === null) continue;
              const current = baseByAccount.get(row.account_id);
              if (current === undefined || row.posted_at < current) {
                baseByAccount.set(row.account_id, row.posted_at);
              }
            }
            for (const row of rows) {
              const newAmount = syntheticAmount(row.amount);
              // A transaction may carry a merchant_key with no matching merchant row; map it on the fly
              // so its identity stays consistent with any sibling that shares the key.
              const newKey =
                row.merchant_key === null
                  ? null
                  : (keyMap.get(row.merchant_key) ?? syntheticMerchantKey(row.merchant_key));
              const newName = syntheticMerchantName(row.merchant_key ?? row.id);
              const base = baseByAccount.get(row.account_id) ?? row.posted_at ?? row.transacted_at;
              const newPosted =
                row.posted_at === null || base === null
                  ? row.posted_at
                  : syntheticDayOffsetIso(row.posted_at, base);
              const newTransacted =
                row.transacted_at === null || base === null
                  ? row.transacted_at
                  : syntheticDayOffsetIso(row.transacted_at, base);
              // import_hash needs branded inputs; the synthetic key is already MerchantKey, fall back to
              // a branded empty key when the row had none (the hash just folds in the empty segment).
              const hashKey = newKey ?? decodeMerchantKey("");
              const newHash = importHash(decodeAccountId(row.account_id), newAmount, hashKey);
              yield* sql`
                UPDATE transaction SET
                  amount          = ${newAmount},
                  description_raw = ${newName},
                  bridge_payee    = ${newName},
                  imported_payee  = ${newName},
                  payee           = ${newName},
                  merchant_key    = ${newKey},
                  posted_at       = ${newPosted},
                  transacted_at   = ${newTransacted},
                  import_hash     = ${newHash}
                WHERE id = ${row.id}
              `;
            }

            // ---- account: fake name + balances + balance_date; keep type/class/enrollment/sfin id ----
            const accounts = yield* sql<AccountRow>`
              SELECT id, balance::text AS balance, available_balance::text AS available_balance
              FROM account
            `;
            let accountIndex = 0;
            for (const account of accounts) {
              accountIndex += 1;
              const balance = account.balance === null ? null : syntheticAmount(account.balance);
              const available =
                account.available_balance === null ? null : syntheticAmount(account.available_balance);
              yield* sql`
                UPDATE account SET
                  name              = ${`Account ${accountIndex}`},
                  balance           = ${balance},
                  available_balance = ${available},
                  balance_date      = NULL
                WHERE id = ${account.id}
              `;
            }

            // ---- institution: fake name, drop domain/url; keep id (FK target) and color ----
            const institutions = yield* sql<{ id: string }>`SELECT id FROM institution`;
            let institutionIndex = 0;
            for (const institution of institutions) {
              institutionIndex += 1;
              yield* sql`
                UPDATE institution SET
                  name   = ${`Institution ${institutionIndex}`},
                  domain = NULL,
                  url    = NULL
                WHERE id = ${institution.id}
              `;
            }

            // ---- person: fake name; keep id (FK target), kind, the split linkage ----
            const people = yield* sql<{ id: string }>`SELECT id FROM person ORDER BY sort_order, id`;
            let personIndex = 0;
            for (const person of people) {
              personIndex += 1;
              yield* sql`UPDATE person SET name = ${`Person ${personIndex}`} WHERE id = ${person.id}`;
            }

            // ---- connection: scrub the secret (and any provider message in last_error) ----
            yield* sql`UPDATE connection SET access_url = 'redacted://anonymized', last_error = NULL`;

            return {
              txid,
              transactions: rows.length,
              accounts: accounts.length,
              merchants: merchants.length,
            } satisfies AnonymizeResult;
          }),
        );
      });

      return { anonymizeAll } as const;
    }),
  },
) {}

/** Live layer: AnonymizeStore backed by whatever SqlClient is provided. */
export const AnonymizeStoreLayer = Layer.effect(AnonymizeStore)(AnonymizeStore.make);
