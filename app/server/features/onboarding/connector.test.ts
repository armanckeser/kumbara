// Regression tests for the FixtureConnector — the synthetic side of the onboarding seam.
//
// These guard the contract the RealConnector must share (so a green fixture test is a real signal):
//   - a malformed / non-fixture setup token must FAIL, never mint a bogus access URL (a real token
//     reaching the fixture layer must be rejected, not silently "claimed").
//   - claim -> discover must decode the two-org fixture into the exact accounts/orgs the file declares.
//   - a missing discovery fixture must fail with the typed ConnectorDiscoverError.
// Per testing-discipline: each test names the regression, drives only the public Connector API, asserts
// hardcoded values from the fixture (never values computed by calling the connector), and includes the
// negative cases. The FixtureConnector needs FileSystem+Path; no DB and no network are involved.

import { assert, layer } from "@effect/vitest";
import { Effect, Encoding, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Connector, FixtureConnectorLayer } from "./connector";
import { ConnectorClaimError, ConnectorDiscoverError } from "./errors";

const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const TestLayer = Layer.provide(FixtureConnectorLayer, PlatformLayer);

/** Build a synthetic setup token: base64 of the fixture claim URL naming a discovery fixture. */
const fixtureToken = (fixtureName: string): string =>
  Encoding.encodeBase64(`https://fixture.example/claim/${fixtureName}`);

layer(TestLayer)("FixtureConnector", (it) => {
  it.effect("claim rejects a token that is not valid base64", () =>
    Effect.gen(function* () {
      const connector = yield* Connector;
      const outcome = yield* Effect.flip(connector.claim("!!!not base64!!!"));
      assert.instanceOf(outcome, ConnectorClaimError);
    }),
  );

  it.effect("claim rejects a real (non-fixture) claim URL rather than minting an access URL", () =>
    Effect.gen(function* () {
      const connector = yield* Connector;
      // A real SimpleFIN token decodes to a bridge.simplefin.org claim URL — it must NOT be accepted by
      // the fixture connector (that would mean real onboarding silently ran against synthetic code).
      const realLookingToken = Encoding.encodeBase64(
        "https://bridge.simplefin.org/simplefin/claim/REAL-TOKEN",
      );
      const outcome = yield* Effect.flip(connector.claim(realLookingToken));
      assert.instanceOf(outcome, ConnectorClaimError);
    }),
  );

  it.effect("claim then discover yields the 3 accounts / 2 orgs the two-orgs fixture declares", () =>
    Effect.gen(function* () {
      const connector = yield* Connector;
      const accessUrl = yield* connector.claim(fixtureToken("two-orgs"));
      const discovered = yield* connector.discover(accessUrl);

      const ids = discovered.accounts.map((account) => account.sfin_account_id);
      assert.deepStrictEqual(ids, ["ACT-fixture-checking", "ACT-fixture-savings", "ACT-fixture-card"]);

      // SimpleFIN omits type, so mapDiscovered infers only the near-certain signal: a NEGATIVE balance
      // is a liability (credit_card); a non-negative balance stays 'unknown' for the user to re-type. The
      // fixture's checking (+2143.55) and savings (+11820.00) are positive -> unknown; the card (-642.18)
      // is negative -> credit_card. If inference regressed to the old blind 'checking', this fails.
      const types = discovered.accounts.map((account) => account.type);
      assert.deepStrictEqual(types, ["unknown", "unknown", "credit_card"]);

      // Two distinct orgs across the three accounts.
      const orgIds = new Set(discovered.accounts.map((account) => account.org?.id ?? null));
      assert.deepStrictEqual([...orgIds].sort(), ["ORG-northbank", "ORG-summit"]);

      // The hyphenated wire keys decode into snake_case fields.
      const checking = discovered.accounts[0];
      assert.strictEqual(checking.available_balance, "2043.55");
      assert.strictEqual(checking.balance, "2143.55");
    }),
  );

  it.effect("discover fails with ConnectorDiscoverError for an unknown fixture", () =>
    Effect.gen(function* () {
      const connector = yield* Connector;
      // Mint an access URL for a fixture that does not exist on disk.
      const accessUrl = yield* connector.claim(fixtureToken("does-not-exist"));
      const outcome = yield* Effect.flip(connector.discover(accessUrl));
      assert.instanceOf(outcome, ConnectorDiscoverError);
    }),
  );
});
