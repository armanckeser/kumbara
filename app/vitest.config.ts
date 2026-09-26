import { defineConfig } from "vitest/config";
import path from "node:path";

// app/ is an npm workspace with server/ as a member, so `effect` is hoisted to a single instance —
// server-located and domain-located schemas share one module identity (no dual-package hazard).
//
// Server + shared-domain tests run in Node (no DOM). The pure-core and property suites need no
// database; the DB-interpreter suite gates itself on TEST_DATABASE_URL (see ingest.db.test.ts).
export default defineConfig({
  // Mirror the build's "@" -> src alias (vite.config.ts) so tests that import a src/ module which itself
  // uses "@/..." (e.g. a feature registry pulling in the shared data-table) resolve identically.
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    // The DB-interpreter suites (ingest/onboarding/transactions *.db.test.ts) all run against ONE shared
    // Postgres and several key on the same fixed fixture sfin ids (ACT-fixture-*). Vitest's default
    // cross-file parallelism let two files INSERT/DELETE the same account rows at once -> a Postgres
    // deadlock. Serialize test files so the shared DB sees one file's transactions at a time. The
    // pure/domain suites are sub-second, so the added wall-clock is negligible; correctness of the
    // shared-resource tests wins.
    fileParallelism: false,
    // src/** holds PURE presentation helpers (e.g. the amount formatter) tested without a DOM — they
    // use only Intl/string logic. Component rendering is verified in the browser, not here.
    include: ["server/**/*.test.ts", "domain/**/*.test.ts", "src/**/*.test.ts"],
    // @effect/vitest registers its own test API; no globals needed.
    globals: false,
  },
});
