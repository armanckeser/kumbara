// Integrity tests for the shipped merchant KB (merchant_kb.jsonl) as DATA.
//
// The regression these guard: an entry key that is ALSO another entry's alias. `MerchantResolver.resolve`
// redirects through the file alias map BEFORE any DB lookup, so such an entry's `merchant` row is
// unreachable by resolution — but `MerchantKbSync.upsertEntry` inserts one row per entry KEY, so syncing
// mints a dead duplicate merchant for every one of them. That is precisely the "Amazon Market vs Amazon
// Market R" duplicate the alias map exists to prevent, and the duplicates surface as junk rows ("deposit",
// "check", "payment") in the Merchants view. 104 such entries had accumulated in the seed.
//
// This lives beside the DB suite rather than inside it because the equivalent DB assertion ("no standalone
// row for an alias key") can only fail ONCE per database: after a bad sync the row is already committed, and
// re-syncing UPDATEs rather than INSERTs it, so a delta-based check reads clean while the bug is live. The
// invariant on the seed file is deterministic, needs no Postgres, and cannot be masked by existing rows.
//
// Per testing-discipline: the regression is named above, the seed is read through the PUBLIC loader
// (loadSeedAssets — the same call MerchantResolver and MerchantKbSync make, no re-parsing of the file by
// the test), and expected values are literals from seed/README.md's documented convention.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { loadSeedAssets } from "./seed-loader";

const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** The shipped KB, decoded through the loader the production services use. */
const loadKb = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assets = yield* loadSeedAssets(fileSystem, path);
  return assets.kb;
}).pipe(Effect.provide(PlatformLayer));

describe("merchant KB seed integrity", () => {
  it("test_no_entry_key_is_also_another_entrys_alias", () =>
    Effect.runPromise(
      loadKb.pipe(
        Effect.map((kb) => {
          // seed/README.md: a variant spelling is added as an ALIAS on the canonical entry — never as a
          // second entry. An entry that is both is a dead row minted by sync and never read by resolve.
          const aliasOwnerByAlias = new Map<string, string>();
          for (const entry of kb) {
            for (const alias of entry.aliases ?? []) {
              if (!aliasOwnerByAlias.has(alias)) aliasOwnerByAlias.set(alias, entry.key);
            }
          }
          const violations = kb
            .filter((entry) => {
              const owner = aliasOwnerByAlias.get(entry.key);
              return owner !== undefined && owner !== entry.key;
            })
            .map((entry) => `${entry.key} (alias of ${aliasOwnerByAlias.get(entry.key)})`);
          assert.deepStrictEqual(violations, []);
        }),
      ),
    ));

  it("test_amazon_market_r_is_an_alias_of_amazon_and_not_its_own_entry", () =>
    Effect.runPromise(
      loadKb.pipe(
        Effect.map((kb) => {
          // The specific historical duplicate, pinned as a literal so the general invariant above can never
          // be satisfied by deleting the alias instead of the duplicate entry.
          const amazon = kb.find((entry) => entry.key === "amazon");
          assert.isDefined(amazon);
          // Widened to string[] (no cast — MerchantKey is a branded string, so it IS one): the literal
          // below is not assignable to the branded element type.
          const amazonAliases: string[] = [...(amazon?.aliases ?? [])];
          assert.include(amazonAliases, "amazon market r");
          assert.strictEqual(
            kb.filter((entry) => entry.key === "amazon market r").length,
            0,
            "'amazon market r' must exist only as an alias, never as its own entry",
          );
        }),
      ),
    ));

  it("test_no_alias_is_claimed_by_two_different_entries", () =>
    Effect.runPromise(
      loadKb.pipe(
        Effect.map((kb) => {
          // Negative case: one spelling resolving to two canonicals is ambiguous — whichever entry loads
          // first silently wins (aliasToKey uses first-write), so the resolution would depend on file order.
          const claimants = new Map<string, string[]>();
          for (const entry of kb) {
            for (const alias of entry.aliases ?? []) {
              claimants.set(alias, [...(claimants.get(alias) ?? []), entry.key]);
            }
          }
          const contested = [...claimants.entries()]
            .filter(([, owners]) => owners.length > 1)
            .map(([alias, owners]) => `${alias} <- ${owners.join(", ")}`);
          assert.deepStrictEqual(contested, []);
        }),
      ),
    ));

  it("test_no_duplicate_entry_keys", () =>
    Effect.runPromise(
      loadKb.pipe(
        Effect.map((kb) => {
          // Negative case: two lines with the same key make sync's ON CONFLICT upsert order-dependent —
          // the last line silently wins the canonical name/category.
          const seen = new Set<string>();
          const duplicates: string[] = [];
          for (const entry of kb) {
            if (seen.has(entry.key)) duplicates.push(entry.key);
            seen.add(entry.key);
          }
          assert.deepStrictEqual(duplicates, []);
        }),
      ),
    ));
});
