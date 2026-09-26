# Normalization seed files

These are DATA, not code. Edit them as file diffs to tune how raw bank strings become merchant identities;
re-run KB sync (POST `/api/kb/sync`, or the sync flow) after editing `merchant_kb.jsonl`. The Merchants
view's unresolved rate is the instrument that tells you when a rule/entry is missing.

| File | Job |
|---|---|
| `normalization_rules.yaml` | Ordered cleanup: strip processor prefixes, trailing geo/phone/store noise, drop tokens, apply replaces → a stable `merchant_key`. |
| `merchant_kb.jsonl` | The knowledge base: one merchant per line. Maps a clean key → canonical name, default category, kind. `aliases` are alternate keys that resolve to the same merchant. |
| `p2p_patterns.yaml` | Peer-to-peer rail collapse (Venmo/Zelle/Cash App): a description matching a rail's substring collapses to one merchant instead of minting one per payment note. |
| `payment_patterns.yaml` | CC-payment markers ("AMEX EPAYMENT") shared with transfer detection. |
| `keyword_categories.yaml` | Last-resort category hints by substring. |

## Fixing duplicate merchants (alias map)

When two rows are the same merchant under different spellings ("Amazon Market" vs "Amazon Market R",
"Amc" vs "Amc Theatres"), add the variant `merchant_key` as an ALIAS on the canonical entry. The variant
then resolves to the one canonical merchant instead of a second row.

1. Find the variant's `merchant_key` — it is shown mono under the name in the Merchants view, or:
   `SELECT merchant_key, canonical_name FROM merchant ORDER BY canonical_name;`
2. Add it to the canonical entry's `aliases` array in `merchant_kb.jsonl`. Example:
   `{"key":"amazon","name":"Amazon",...,"aliases":["amzn","amazon market","amazon market r"]}`
3. Re-run KB sync.

Note: adding an alias fixes FUTURE ingests and resolution. Rows already pointing at the now-duplicate
merchant are not repointed automatically — that is a separate one-off cleanup.

Only exact known dupes go here (deterministic, no false merges). There is intentionally no fuzzy
auto-merge.

## Catching a new P2P rail

If a Venmo/Zelle/Cash App row is still landing as its own per-note merchant, its raw description does not
contain a marker we match. Look at the raw string and add the identifying substring to the right rail:

1. `SELECT description_raw FROM transaction WHERE id = '<the row>';`
2. Add the uppercase substring you see (e.g. `VENMO`, `ZELLE`, `CASHAPP*`) to that rail's `patterns` in
   `p2p_patterns.yaml`. Matched case-insensitively as a substring of the raw description.
3. Ensure the rail's `key` exists in `merchant_kb.jsonl` as a `kind":"transfer"` merchant.
