// The DEV / AGENT entrypoint.
//
// Builds the shared Hono app (build-app.ts) against the FIXTURE-bound runtime (runtime.ts) — the Connector
// and FeedSource resolve to synthetic sources, so nothing here can touch the real SimpleFIN feed (R9).
// This is the server the coding agent and `npm run dev` run. The live server is index.prod.ts, a separate
// entrypoint the user runs that swaps in the real sources.

import "dotenv/config";
import { runtime } from "./runtime";
import { buildApp, startServer } from "./build-app";

startServer(buildApp(runtime));
