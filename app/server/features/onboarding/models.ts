// Onboarding feature — the SimpleFIN wire shape and the domain-facing discovery result.
//
// Two layers, kept separate on purpose:
//   - The WIRE schema (SimpleFinDiscoveryResponse and friends) mirrors the documented SimpleFIN
//     `/accounts` response (kumbaradesign.md §0.3, the v2 spec). It is decoded, never trusted blindly,
//     and is the SHARED definition both the FixtureConnector (synthetic) and the user-run RealConnector
//     decode against — one source of truth for the provider shape (R8). The ingestion feature's
//     real-source.ts can import these instead of redeclaring its own copy.
//   - The DOMAIN result (DiscoveredAccount / DiscoveredAccounts) is what the Connector seam yields and
//     the OnboardingStore persists. The mapping wire->domain (mapDiscovered) lives here as a pure
//     function, the same "raw -> normalized" idiom flows.ts uses for transactions.
//
// SimpleFIN delivers no account `type`, so mapDiscovered infers only the one near-certain signal (a
// negative balance is a liability -> credit_card) and leaves everything else `unknown` for the user to
// re-type via PATCH /api/accounts/:id (which re-derives class). See inferType below.

import { Encoding, Schema } from "effect";
import { AccountType, Money, SfinAccountId } from "../../../domain/common";

// ---------- the SimpleFIN wire shape (decoded, never trusted) ----------

/** A SimpleFIN org block. Per §0.3 every field is optional on the wire. */
export class SimpleFinOrg extends Schema.Class<SimpleFinOrg>("kumbara/onboarding/SimpleFinOrg")({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  domain: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {}

/**
 * One account in the SimpleFIN `/accounts` response. `id`/`name` always; the rest optional (the bridge
 * omits absent values). The hyphenated wire keys `available-balance` / `balance-date` are mapped to
 * snake_case fields via Schema.encodeKeys on the response struct below. `transactions` is intentionally
 * NOT modeled here: discovery uses `balances-only=1` (metadata only); transactions arrive later through
 * the ingestion pipeline, which has its own SimpleFinTxn schema.
 */
export const SimpleFinDiscoveredAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  currency: Schema.optionalKey(Schema.String),
  balance: Schema.optionalKey(Schema.String),
  available_balance: Schema.optionalKey(Schema.String),
  balance_date: Schema.optionalKey(Schema.Number), // unix seconds
  org: Schema.optionalKey(SimpleFinOrg),
}).pipe(
  // The wire uses hyphenated keys; the decoded struct uses snake_case. encodeKeys renames the encoded
  // (wire) side without changing the decoded type.
  Schema.encodeKeys({
    available_balance: "available-balance",
    balance_date: "balance-date",
  }),
);
export type SimpleFinDiscoveredAccount = typeof SimpleFinDiscoveredAccount.Type;

/** The top-level `/accounts` response. `errlist` (v2 structured errors) is decoded so a connector can
 *  surface provider-side errors rather than silently dropping them. */
export const SimpleFinDiscoveryResponse = Schema.Struct({
  accounts: Schema.Array(SimpleFinDiscoveredAccount),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SimpleFinDiscoveryResponse = typeof SimpleFinDiscoveryResponse.Type;

// ---------- SimpleFIN request auth ----------

/** A ready-to-send SimpleFIN request: the credential-stripped base URL and the auth headers to attach. */
export interface SimpleFinRequest {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * SimpleFIN embeds the access credentials in the access URL as `https://user:pass@host/path` (the v2
 * "access URL" IS the credential). HTTP clients built on undici (NodeHttpClient.layerUndici) DROP URL
 * userinfo rather than sending it, so the bridge sees an unauthenticated request and answers 403 with
 * `{"errors":["No credentials provided"],"accounts":[]}` — a well-formed but empty body that decodes to
 * zero accounts. Convert the userinfo into an explicit HTTP Basic `Authorization` header (which Effect's
 * HttpClient also auto-redacts in logs/spans, unlike a URL) and return the credential-stripped base URL
 * for the caller to append `/accounts` to. Pure; both live sources (discovery + ingestion) use it.
 */
export const simpleFinRequestAuth = (accessUrl: string): SimpleFinRequest => {
  const url = new URL(accessUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  const baseUrl = url.toString().replace(/\/$/, "");
  if (username.length === 0 && password.length === 0) {
    return { baseUrl, headers: {} };
  }
  const credentials = Encoding.encodeBase64(`${username}:${password}`);
  return { baseUrl, headers: { Authorization: `Basic ${credentials}` } };
};

// ---------- the domain-facing discovery result ----------

/** An org as the store will upsert it into `institution`. */
export class DiscoveredOrg extends Schema.Class<DiscoveredOrg>("kumbara/onboarding/DiscoveredOrg")({
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  domain: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
}) {}

/** One discovered account, normalized into the shape the OnboardingStore persists at enrollment=discovered. */
export class DiscoveredAccount extends Schema.Class<DiscoveredAccount>(
  "kumbara/onboarding/DiscoveredAccount",
)({
  sfin_account_id: SfinAccountId,
  name: Schema.String,
  type: AccountType,
  currency: Schema.String,
  balance: Schema.NullOr(Money),
  available_balance: Schema.NullOr(Money),
  balance_date: Schema.NullOr(Schema.String), // ISO 8601
  org: Schema.NullOr(DiscoveredOrg),
}) {}

/**
 * The whole discovery result — the accounts a connection bridges, plus any provider-side `errors` the
 * bridge reported alongside them. SimpleFIN can answer with `accounts:[]` AND a non-empty `errors`
 * (e.g. "Connection to … may need attention"); carrying `errors` here lets the flow explain an empty
 * discovery instead of silently reporting "0 discovered".
 */
export class DiscoveredAccounts extends Schema.Class<DiscoveredAccounts>(
  "kumbara/onboarding/DiscoveredAccounts",
)({
  accounts: Schema.Array(DiscoveredAccount),
  errors: Schema.Array(Schema.String),
}) {}

// ---------- pure wire -> domain mapping ----------

const decodeSfinAccountId = Schema.decodeUnknownSync(SfinAccountId);
const decodeMoney = Schema.decodeUnknownSync(Money);

/**
 * SimpleFIN's balances-only discovery reports no account `type`, so we infer only the ONE signal that is
 * near-certain and leave everything else honestly unclassified for the user to type:
 *   - a NEGATIVE balance is money owed → a liability → `credit_card` (the common case; the user re-types
 *     a loan if that is what it is).
 *   - anything else → `unknown`. We deliberately do NOT guess checking-vs-savings from the presence of an
 *     available-balance: that signal is too weak, and a wrong guess is exactly the annoyance this replaces
 *     (the old blind `checking` default). `unknown` is inert (discovered + off-budget) until retyped.
 * Pure; the balance is the already-decoded Money string (or null when the bridge omitted it).
 */
const inferType = (balance: Money | null): typeof AccountType.Type => {
  if (balance !== null && Number(balance) < 0) return "credit_card";
  return "unknown";
};

/** ISO from SimpleFIN unix-seconds, mirroring ingestion/flows.ts isoFromUnix. */
const isoFromUnix = (seconds: number): string => new Date(seconds * 1000).toISOString();

const orgFrom = (org: SimpleFinOrg | undefined): DiscoveredOrg | null => {
  if (org === undefined) return null;
  return new DiscoveredOrg({
    id: org.id ?? null,
    name: org.name ?? null,
    domain: org.domain ?? null,
    url: org.url ?? null,
  });
};

const accountFrom = (account: SimpleFinDiscoveredAccount): DiscoveredAccount => {
  const balance = account.balance === undefined ? null : decodeMoney(account.balance);
  return new DiscoveredAccount({
    sfin_account_id: decodeSfinAccountId(account.id),
    name: account.name,
    type: inferType(balance),
    currency: account.currency ?? "USD",
    balance,
    available_balance:
      account.available_balance === undefined ? null : decodeMoney(account.available_balance),
    balance_date: account.balance_date === undefined ? null : isoFromUnix(account.balance_date),
    org: orgFrom(account.org),
  });
};

/** Map a decoded SimpleFIN response onto the domain discovery result. Pure. `errors` is carried through
 *  (defaulting to [] when the bridge omitted it) so the flow can surface a provider reason for an empty
 *  discovery rather than dropping it. */
export const mapDiscovered = (response: SimpleFinDiscoveryResponse): DiscoveredAccounts =>
  new DiscoveredAccounts({
    accounts: response.accounts.map(accountFrom),
    errors: response.errors ?? [],
  });
