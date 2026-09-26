// FeedSource — the two-layer seam (R9).
//
// This is the ONLY place that knows whether ingested data came from a synthetic fixture file or the
// live SimpleFIN bridge. Everything downstream (normalize, reconcile, flows, the DB interpreter) sees
// only a `FeedBatch` and is identical for both layers — that is what makes a green fixture test a real
// signal for the live run, while keeping real transaction data out of the coding agent's context.
//
//   FixtureSource  — reads fixtures/<name>.json. The coding agent builds and tests against this.
//   RealFeedSource — bridges the live feed (server/features/ingestion/sources/real-source.ts). Written
//                    by the agent, run ONLY by the user / their personal Claude. Never imported here.

import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FixtureDecodeError, FixtureNotFound } from "./errors";
import { FeedBatch, FixtureFile } from "./models";

/**
 * Supplies one feed batch on demand. `fixture` names the source (a fixture file name, or — for the
 * real source — a connected-account selector); `batch` names which pull within it (e.g. "pending").
 * `accessUrl` is the per-connection credential the real source pulls from; it is passed in by the caller
 * (from the DB `connection.access_url`) so multiple connections can be synced by one runtime. The fixture
 * source ignores it, and the real source falls back to SIMPLEFIN_ACCESS_URL when it is absent (preserving
 * the single-connection `real-run.ts` entrypoint). It is a plain string here, wrapped Redacted only where
 * the real source actually uses it, so it never lands in a fixture-source log.
 */
export class FeedSource extends Context.Service<FeedSource>()("kumbara/ingestion/FeedSource", {
  make: Effect.succeed({
    // `startDate`/`endDate` (unix seconds) bound the pull window; the fixture source ignores them, the
    // real source appends `?start-date=&end-date=`. `endDate` is the chunked-backfill knob: the bridge
    // truncates a >90-day range, so a deep backfill walks explicit [start,end] windows (see backfill.ts).
    loadBatch: (
      _fixture: string,
      _batch: string,
      _accessUrl?: string,
      _startDate?: number,
      _endDate?: number,
    ) =>
      Effect.fail(
        new FixtureNotFound({ fixture: "FeedSource has no default implementation; provide a layer" }),
      ) as Effect.Effect<FeedBatch, FixtureNotFound | FixtureDecodeError>,
    // loadConnection pulls EVERY requested account for one connection in a SINGLE upstream call. SimpleFIN
    // has a hard 24-calls/24h quota and `GET /accounts` returns all of a connection's accounts at once, so
    // sync must fan IN to one call per connection, not one per account. `accountSelectors` are the sfin
    // account ids to return batches for; the real source fetches once and picks them out, the fixture
    // source loads each selector's fixture. A selector with no data is simply omitted from the result.
    loadConnection: (
      _accountSelectors: readonly string[],
      _accessUrl?: string,
      _startDate?: number,
      _endDate?: number,
    ) =>
      Effect.fail(
        new FixtureNotFound({ fixture: "FeedSource has no default implementation; provide a layer" }),
      ) as Effect.Effect<readonly FeedBatch[], FixtureNotFound | FixtureDecodeError>,
  }),
}) {}

const decodeFixtureFile = Schema.decodeUnknownEffect(FixtureFile);

/**
 * Reads synthetic fixtures from `fixtures/<name>.json`, decodes them, and returns the requested named
 * batch as a FeedBatch. A missing file or unknown batch fails with a typed error; a malformed file
 * fails with FixtureDecodeError — synthetic data problems surface loudly, never silently.
 */
export const FixtureSourceLayer = Layer.effect(FeedSource)(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixturesDir = path.join(import.meta.dirname, "fixtures");

    // Load + decode one fixture file into a FeedBatch for the named batch. Shared by loadBatch and
    // loadConnection (which just maps it over several selectors).
    const loadOne = Effect.fn("FixtureSource.loadOne")(function* (fixture: string, batch: string) {
      const file = path.join(fixturesDir, `${fixture}.json`);

      const exists = yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return yield* Effect.fail(new FixtureNotFound({ fixture }));
      }

      const raw = yield* fileSystem.readFileString(file).pipe(
        Effect.mapError(
          (cause) => new FixtureDecodeError({ fixture, message: `unreadable: ${cause.message}` }),
        ),
      );

      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          new FixtureDecodeError({ fixture, message: `invalid JSON: ${String(cause)}` }),
      });

      const decoded = yield* decodeFixtureFile(parsed).pipe(
        Effect.mapError((cause) => new FixtureDecodeError({ fixture, message: cause.message })),
      );

      const transactions = decoded.batches[batch];
      if (transactions === undefined) {
        return yield* Effect.fail(
          new FixtureDecodeError({ fixture, message: `no batch named "${batch}"` }),
        );
      }

      return new FeedBatch({ account: decoded.account, transactions, holdings: decoded.holdings ?? [] });
    });

    return {
      // `accessUrl`/`startDate`/`endDate` are meaningless for a fixture file (the batch is on disk); accept
      // + ignore them so the seam is one shape for both layers.
      loadBatch: Effect.fn("FixtureSource.loadBatch")(function* (
        fixture: string,
        batch: string,
        _accessUrl?: string,
        _startDate?: number,
        _endDate?: number,
      ) {
        return yield* loadOne(fixture, batch);
      }),
      // Fixtures are single-account files, so a "connection" pull just loads each requested selector's
      // fixture (using the selector as the fixture name — the agent runtime's meaning of the selector).
      // The real source is the one that collapses this to a single HTTP call.
      loadConnection: Effect.fn("FixtureSource.loadConnection")(function* (
        accountSelectors: readonly string[],
        _accessUrl?: string,
        _startDate?: number,
        _endDate?: number,
      ) {
        const batches: FeedBatch[] = [];
        for (const selector of accountSelectors) {
          batches.push(yield* loadOne(selector, "live"));
        }
        return batches;
      }),
    };
  }),
);
