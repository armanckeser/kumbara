// ⚠️  THE LIVE server entrypoint. The agent may edit it, build it, and boot it against a LOCAL/synthetic
//     DB to verify the prod code path — R9 only forbids binding the REAL feed or reading the deployed
//     prod URL. Do NOT run it with a real SimpleFIN token or point it at the production database.  ⚠️
//
// Same shared Hono app as the dev server (build-app.ts), but built against the REAL-bound runtime
// (runtime.prod.ts) so Connect claims a real SimpleFIN token and Sync pulls the live bridge (R9). It also
// forks a background sync fiber so transactions refresh without a manual tap. This is the image the Pi's
// docker-compose runs behind Cosmos.
//
// Env it reads (see .env.prod.example): DATABASE_URL, ELECTRIC_URL, PORT, HOST, SERVE_WEB, WEB_ROOT,
// CORS_ORIGIN, SIMPLEFIN_START_DATE (first-pull backfill), SYNC_INTERVAL_MINUTES (0 disables the schedule).

import "dotenv/config";
import { Effect, Schedule, Duration } from "effect";
import { productionRuntime } from "./runtime.prod";
import { buildApp, startServer } from "./build-app";
import { runSync } from "./features/ingestion/sync";
import { QuoteStore } from "./features/quotes/quote-store";

startServer(buildApp(productionRuntime));

// ---------- scheduled background sync ----------
// Pull every enabled connected account on a fixed cadence so data stays fresh without the user tapping
// "Sync now". A run's own failures are already isolated per-account inside runSync (a bad bank does not
// abort the others); we additionally catch at the fiber level so one bad tick never kills the schedule.
// SYNC_INTERVAL_MINUTES=0 (or unset-to-default) tunes/disables it.
// Daily by default. SimpleFIN has a HARD 24-calls/24h quota; with the per-connection pull (one call per
// connection, not per account) a daily tick uses ~1 call per bank, leaving ample headroom for manual
// "Sync now". SYNC_INTERVAL_MINUTES=0 disables the schedule.
const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES ?? 1440);

if (SYNC_INTERVAL_MINUTES > 0) {
  const scheduledSync = Effect.gen(function* () {
    // `now` is read at each tick so pace/void windows use the tick's clock.
    const summary = yield* runSync(new Date().toISOString());
    yield* Effect.log(
      `scheduled sync: ${summary.synced} synced, ${summary.failed} failed, ${summary.links.proposed} links proposed`,
    );
    // Portfolio health (Pitch 41): after the accounts are fresh, reprice manual positions from the live
    // quote source and re-capture today's value-history snapshots (refreshQuotes does both). Isolated
    // with its own catch so a quote-provider outage never marks the SYNC tick failed — prices simply
    // stay a day older and the freshness card says so.
    const quoteStore = yield* QuoteStore;
    const refresh = yield* quoteStore
      .refreshQuotes(new Date().toISOString())
      .pipe(Effect.catchCause((cause) => Effect.logError("scheduled quote refresh failed", cause).pipe(Effect.as(null))));
    if (refresh !== null) {
      yield* Effect.log(
        `scheduled quote refresh: ${refresh.positions_updated} positions repriced, ${refresh.snapshots_captured} snapshots captured, ${refresh.symbols_skipped.length} symbols skipped`,
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("scheduled sync tick failed", cause)),
    // spaced() waits the interval BETWEEN runs; the first run happens on start, then every N minutes.
    Effect.repeat(Schedule.spaced(Duration.minutes(SYNC_INTERVAL_MINUTES))),
    // The boot-time first run stays (with daily spacing and frequent deploys it IS the effective sync
    // trigger) but waits out the post-deploy window: an immediate run monopolizes the Pi's single Node
    // process for ~20s exactly when the user reopens the app to check the deploy, which read as a ~10s
    // dead budget page. Five minutes later nobody is racing it.
    Effect.delay(Duration.minutes(5)),
  );

  productionRuntime.runFork(scheduledSync);
  console.log(`scheduled sync every ${SYNC_INTERVAL_MINUTES} min`);
} else {
  console.log("scheduled sync disabled (SYNC_INTERVAL_MINUTES=0)");
}
