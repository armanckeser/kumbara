// Seed loader — the ONE place that reads + decodes the versioned normalization seed files.
//
// Both the MerchantResolver (applies the rules at ingest) and KB sync (loads the KB into `merchant`)
// need this data, so it is loaded here once rather than in each consumer (single source of truth). Reads
// via Effect FileSystem/Path (the fixture idiom), parses, and decodes each against its domain schema — a
// malformed seed fails with a typed SeedLoadError instead of silently yielding empty rules.

import { Effect, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as YAML from "yaml";
import {
  KeywordDictionary,
  MerchantKbEntry,
  NormalizationRules,
  P2pRules,
  PaymentPatterns,
  PosPrefixDictionary,
} from "../../../domain/normalization";
import { SeedLoadError } from "./errors";

const decodeRules = Schema.decodeUnknownEffect(NormalizationRules);
const decodePatterns = Schema.decodeUnknownEffect(PaymentPatterns);
const decodeKbEntry = Schema.decodeUnknownEffect(MerchantKbEntry);
const decodeKeywords = Schema.decodeUnknownEffect(KeywordDictionary);
const decodeP2pRules = Schema.decodeUnknownEffect(P2pRules);
const decodePosPrefixes = Schema.decodeUnknownEffect(PosPrefixDictionary);

/** Everything the seed files carry, decoded and ready to use. */
export interface SeedAssets {
  readonly rules: NormalizationRules;
  readonly paymentPatterns: PaymentPatterns;
  /** Internal-transfer substrings (transfer_patterns.yaml) — same shape as paymentPatterns, distinct
   *  meaning (money between accounts vs a CC bill). Feeds merchant.kind at resolution (classify-kind.ts). */
  readonly transferPatterns: PaymentPatterns;
  readonly kb: ReadonlyArray<MerchantKbEntry>;
  readonly keywords: KeywordDictionary;
  readonly posPrefixes: PosPrefixDictionary;
  readonly p2pRules: P2pRules;
}

/** Read a file as a string, mapping an unreadable file to a typed SeedLoadError. */
const readFile = Effect.fn("seed.readFile")(function* (
  fileSystem: FileSystem.FileSystem,
  file: string,
  label: string,
) {
  return yield* fileSystem.readFileString(file).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: label, message: `unreadable: ${cause.message}` })),
  );
});

/** Parse YAML text into an unknown value, mapping a parse failure to a typed SeedLoadError. */
const parseYaml = Effect.fn("seed.parseYaml")(function* (raw: string, label: string) {
  return yield* Effect.try({
    try: () => YAML.parse(raw) as unknown,
    catch: (cause) => new SeedLoadError({ file: label, message: `invalid YAML: ${String(cause)}` }),
  });
});

/**
 * Load and decode all seed files from the sibling `seed/` directory. Fails with SeedLoadError on a
 * missing/unreadable/undecodable file. JSONL is split on newlines (blank lines skipped) and each line is
 * decoded independently, so a bad line names itself.
 *
 * FileSystem/Path are passed IN (acquired by the caller at layer-construction, the FixtureSource idiom)
 * so the returned effect names no platform requirement — consumers can call it per-request without
 * FileSystem/Path leaking into their signature.
 */
export const loadSeedAssets = Effect.fn("seed.loadSeedAssets")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const seedDir = path.join(import.meta.dirname, "seed");

  const rulesRaw = yield* readFile(fileSystem, path.join(seedDir, "normalization_rules.yaml"), "normalization_rules.yaml");
  const rulesParsed = yield* parseYaml(rulesRaw, "normalization_rules.yaml");
  const rules = yield* decodeRules(rulesParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "normalization_rules.yaml", message: cause.message })),
  );

  const patternsRaw = yield* readFile(fileSystem, path.join(seedDir, "payment_patterns.yaml"), "payment_patterns.yaml");
  const patternsParsed = yield* parseYaml(patternsRaw, "payment_patterns.yaml");
  const paymentPatterns = yield* decodePatterns(patternsParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "payment_patterns.yaml", message: cause.message })),
  );

  const transferRaw = yield* readFile(fileSystem, path.join(seedDir, "transfer_patterns.yaml"), "transfer_patterns.yaml");
  const transferParsed = yield* parseYaml(transferRaw, "transfer_patterns.yaml");
  const transferPatterns = yield* decodePatterns(transferParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "transfer_patterns.yaml", message: cause.message })),
  );

  const kbRaw = yield* readFile(fileSystem, path.join(seedDir, "merchant_kb.jsonl"), "merchant_kb.jsonl");
  const lines = kbRaw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const kb: MerchantKbEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: (cause) =>
        new SeedLoadError({ file: "merchant_kb.jsonl", message: `line ${index + 1}: invalid JSON: ${String(cause)}` }),
    });
    const entry = yield* decodeKbEntry(parsed).pipe(
      Effect.mapError((cause) => new SeedLoadError({ file: "merchant_kb.jsonl", message: `line ${index + 1}: ${cause.message}` })),
    );
    kb.push(entry);
  }

  const keywordsRaw = yield* readFile(fileSystem, path.join(seedDir, "keyword_categories.yaml"), "keyword_categories.yaml");
  const keywordsParsed = yield* parseYaml(keywordsRaw, "keyword_categories.yaml");
  const keywords = yield* decodeKeywords(keywordsParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "keyword_categories.yaml", message: cause.message })),
  );

  const p2pRaw = yield* readFile(fileSystem, path.join(seedDir, "p2p_patterns.yaml"), "p2p_patterns.yaml");
  const p2pParsed = yield* parseYaml(p2pRaw, "p2p_patterns.yaml");
  const p2pRules = yield* decodeP2pRules(p2pParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "p2p_patterns.yaml", message: cause.message })),
  );

  const posPrefixRaw = yield* readFile(fileSystem, path.join(seedDir, "pos_prefix_categories.yaml"), "pos_prefix_categories.yaml");
  const posPrefixParsed = yield* parseYaml(posPrefixRaw, "pos_prefix_categories.yaml");
  const posPrefixes = yield* decodePosPrefixes(posPrefixParsed).pipe(
    Effect.mapError((cause) => new SeedLoadError({ file: "pos_prefix_categories.yaml", message: cause.message })),
  );

  return { rules, paymentPatterns, transferPatterns, kb, keywords, posPrefixes, p2pRules } satisfies SeedAssets;
});
