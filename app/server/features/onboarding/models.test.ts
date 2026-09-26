// Regression tests for simpleFinRequestAuth — the SimpleFIN access-URL -> request-auth transform.
//
// The regression these guard: the SimpleFIN access URL carries its credentials as userinfo
// (`https://user:pass@host/path`), but the app's HTTP client (undici) DROPS URL userinfo. Before this
// transform existed, every live discovery/ingestion request went out unauthenticated, the bridge
// answered 403 with a well-formed `{"errors":[...],"accounts":[]}` body, and the app silently decoded
// "0 accounts discovered" — no error, no reason. The transform must lift the userinfo into an HTTP
// Basic `Authorization` header and hand back the credential-stripped base URL to build endpoints from.
//
// Per testing-discipline: the regression is named above, the test drives only the exported function,
// expected base64 strings are spec literals (computed once with `base64`, not by calling the function),
// and the no-credentials path is the negative case (must NOT emit an Authorization header).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { SimpleFinDiscoveryResponse, mapDiscovered, simpleFinRequestAuth } from "./models";

describe("simpleFinRequestAuth", () => {
  it.each([
    {
      name: "lifts userinfo into a Basic header and strips it from the URL",
      accessUrl: "https://user123:pass456@bridge.example.org/simplefin",
      expectedBaseUrl: "https://bridge.example.org/simplefin",
      expectedAuthorization: "Basic dXNlcjEyMzpwYXNzNDU2",
    },
    {
      name: "strips a trailing slash so callers can append /accounts",
      accessUrl: "https://user123:pass456@bridge.example.org/simplefin/",
      expectedBaseUrl: "https://bridge.example.org/simplefin",
      expectedAuthorization: "Basic dXNlcjEyMzpwYXNzNDU2",
    },
    {
      name: "percent-decodes credentials before base64-encoding them",
      accessUrl: "https://user:p%40ss@bridge.example.org/x",
      expectedBaseUrl: "https://bridge.example.org/x",
      expectedAuthorization: "Basic dXNlcjpwQHNz",
    },
  ])("$name", ({ accessUrl, expectedBaseUrl, expectedAuthorization }) => {
    const request = simpleFinRequestAuth(accessUrl);
    assert.strictEqual(request.baseUrl, expectedBaseUrl);
    assert.strictEqual(request.headers.Authorization, expectedAuthorization);
  });

  it("emits no Authorization header when the URL carries no credentials", () => {
    const request = simpleFinRequestAuth("https://bridge.example.org/simplefin");
    assert.strictEqual(request.baseUrl, "https://bridge.example.org/simplefin");
    assert.deepStrictEqual(request.headers, {});
  });
});

// Regression guarded: SimpleFIN's balances-only discovery carries no account `type`. The mapper used to
// blindly stamp every discovered account 'checking', which mis-typed savings/cards and forced the user to
// fix every one. mapDiscovered must now infer ONLY the near-certain signal (negative balance -> liability
// -> credit_card) and leave every non-negative / absent balance 'unknown' for the user to type. A weaker
// or wrong guess (e.g. checking again, or guessing savings) is the regression. Per testing-discipline:
// the input is decoded through the real wire schema (public boundary), expected types are spec literals.
describe("mapDiscovered type inference", () => {
  const decodeResponse = Schema.decodeUnknownSync(SimpleFinDiscoveryResponse);

  it.each([
    { name: "negative balance", balance: "-642.18", expected: "credit_card" },
    { name: "positive balance", balance: "2143.55", expected: "unknown" },
    { name: "zero balance", balance: "0.00", expected: "unknown" },
  ])("types a $name account as $expected", ({ balance, expected }) => {
    const response = decodeResponse({
      accounts: [{ id: "ACT-x", name: "An account", currency: "USD", balance }],
    });
    const discovered = mapDiscovered(response);
    assert.strictEqual(discovered.accounts[0].type, expected);
  });

  it("types an account with no balance field as unknown", () => {
    const response = decodeResponse({ accounts: [{ id: "ACT-y", name: "No balance", currency: "USD" }] });
    const discovered = mapDiscovered(response);
    assert.strictEqual(discovered.accounts[0].type, "unknown");
    assert.strictEqual(discovered.accounts[0].balance, null);
  });
});

// Regression guarded: SimpleFIN can answer with `accounts:[]` AND a non-empty `errors` array (e.g. a bank
// link that needs re-auth). mapDiscovered used to decode `errors` and then DROP it — it mapped only
// `response.accounts` — so a reasoned empty discovery reached the flow as an indistinguishable "0
// accounts, no reason". mapDiscovered must carry `errors` through onto the domain result. Per
// testing-discipline: input is decoded through the real wire schema, expected values are spec literals
// from the response, and the no-errors case is the negative (must normalize to []).
describe("mapDiscovered errors passthrough", () => {
  const decodeResponse = Schema.decodeUnknownSync(SimpleFinDiscoveryResponse);

  it("carries a bridge errors array onto the domain result when accounts is empty", () => {
    const response = decodeResponse({
      accounts: [],
      errors: ["Connection to Northbank may need attention"],
    });
    const discovered = mapDiscovered(response);
    assert.deepStrictEqual(discovered.errors, ["Connection to Northbank may need attention"]);
    assert.strictEqual(discovered.accounts.length, 0);
  });

  it("carries errors alongside a partial account list", () => {
    const response = decodeResponse({
      accounts: [{ id: "ACT-ok", name: "Working", currency: "USD", balance: "10.00" }],
      errors: ["Connection to Summit may need attention"],
    });
    const discovered = mapDiscovered(response);
    assert.deepStrictEqual(discovered.errors, ["Connection to Summit may need attention"]);
    assert.strictEqual(discovered.accounts.length, 1);
  });

  it("normalizes an omitted errors field to an empty array", () => {
    const response = decodeResponse({
      accounts: [{ id: "ACT-ok", name: "Working", currency: "USD", balance: "10.00" }],
    });
    const discovered = mapDiscovered(response);
    assert.deepStrictEqual(discovered.errors, []);
  });
});
