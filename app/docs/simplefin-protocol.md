# SimpleFIN Protocol (v2)

> The authoritative wire shape our client decodes against. Pasted from the SimpleFIN Protocol docs by
> the user on 2026-07-02. Our wire schemas (`server/features/ingestion/models.ts`,
> `server/features/ingestion/sources/real-source.ts`, `server/features/onboarding/models.ts`) must
> match this. Real-feed observations that EXTEND or refine this spec are recorded in
> `../../kumbaradesign.md` §0.3 (the live 2026-06-29 pull) — notably **holdings**, which the base
> protocol below does NOT document but the SimpleFIN **Bridge** returns in full for investment
> accounts (`cost_basis, market_value, shares, symbol`, underscore-cased).

## Error

| Attribute | Type | Required | Description |
|---|---|---|---|
| code | string | yes | One of the codes listed below |
| msg | string | yes | String error suitable for displaying to users |
| conn_id | string | no | Connection id. Only given if the error is specific to a particular connection. |
| account_id | string | no | Account id. Only given if the error is specific to a particular account. |

### Codes

Error codes are in the format `prefix.[subcode]`. Current valid prefixes are `gen`, `con`, or `act`
indicating General, Connection, or Account errors respectively.

Consumers of the protocol should handle unknown subcodes by falling back to treating the error like a
naked `prefix.`.

| Code | Extra attributes | Description |
|---|---|---|
| `gen.` | | General error |
| `gen.api` | | Error in how the API is being used. Meant for the developer, not the user. |
| `gen.auth` | | General authentication error (to the SimpleFIN Server) |
| `con.` | conn_id | General connection-level error |
| `con.auth` | conn_id | Authentication issue for a connection |
| `act.` | account_id | General account-level error |
| `act.failed` | account_id | Failed to get account information. Try again later. |
| `act.missingdata` | account_id | Incomplete transaction listing. Try again later. |

```json
{
  "code": "gen.auth",
  "msg": "No credentials provided"
}
```

```json
{
  "code": "con.auth",
  "msg": "Authentication failed for My Bank - Jim",
  "conn_id": "CON-21983498-29349823984293842"
}
```

```json
{
  "code": "act.failed",
  "msg": "Failed to get all transactions. Try again later.",
  "account_id": "ACT-1982398-12398192839182398123"
}
```

## Connection

Represents a single connection to an institution. Users with 2 sets of login credentials for a
particular bank will have 2 different Connections, each with the same `org_*` fields.

| Attribute | Type | Required | Description |
|---|---|---|---|
| conn_id | string | yes | ID of a particular connection for a financial institution. |
| name | string | yes | Human-friendly name for this connection. Includes the financial institution name (may be identical to it in some cases). |
| org_id | string | yes | ID of the financial institution. Unique per SimpleFIN server, not guaranteed globally unique. |
| org_url | string | no | Domain name of the financial institution |
| sfin_url | string | yes | Root URL of organization's SimpleFIN Server |

```json
{
  "conn_id": "CON-923049234-203940293409234",
  "name": "My Bank - Jill",
  "org_id": "ORG-8293948-230482398492834",
  "org_url": "https://mybank.com",
  "sfin_url": "https://sfin.mybank.com"
}
```

## Account Set

| Attribute | Type | Required | Description |
|---|---|---|---|
| errlist | array of Errors | yes | List of errors |
| errors | array | no (DEPRECATED) | Array of strings suitable for displaying to a user. |
| connections | array of Connections | yes | List of Connections. |
| accounts | array of Accounts | yes | List of Accounts. |

```json
{
  "errlist": [],
  "connections": [
    {
      "conn_id": "CON-1122121298398234234",
      "name": "My Bank - Jill",
      "org_id": "INST-1298391823-129381928391823",
      "org_url": "https://mybank.com",
      "sfin_url": "https://sfin.mybank.com"
    }
  ],
  "accounts": [
    {
      "id": "2930002",
      "name": "Savings",
      "conn_id": "CON-1122121298398234234",
      "currency": "USD",
      "balance": "100.23",
      "available-balance": "75.23",
      "balance-date": 978366153,
      "transactions": [
        {
          "id": "12394832938403",
          "posted": 793090572,
          "amount": "-33293.43",
          "description": "Uncle Frank's Bait Shop"
        }
      ],
      "extra": {
        "account-open-date": 978360153
      }
    }
  ]
}
```

## Account

| Attribute | Type | Required | Description |
|---|---|---|---|
| id | string | yes | Uniquely identifies the account within the Connection. Recommended to not reveal sensitive data. |
| name | string | yes | A name that uniquely describes an account among the user's other accounts. |
| conn_id | string | yes | ID of the account's Connection |
| currency | string | yes | ISO 4217 currency code (e.g. "ZMW", "USD"), or a custom-currency URL (see below). |
| balance | numeric string | yes | The balance of the account as of `balance-date`. |
| available-balance | numeric string | optional | The available balance as of `balance-date`. Omitted if same as `balance`. |
| balance-date | UNIX epoch timestamp | yes | When `balance`/`available-balance` became what they are. |
| transactions | array of Transactions | optional | A subset of Transactions for this account, ordered by `posted`. |
| extra | object | optional | Extra account-specific data not defined in this standard. Server's choice. |

```json
{
  "id": "2930002",
  "name": "Savings",
  "conn_id": "1238239482348382932",
  "currency": "USD",
  "balance": "100.23",
  "available-balance": "75.23",
  "balance-date": 978366153,
  "transactions": [
    {
      "id": "12394832938403",
      "posted": 793090572,
      "amount": "-33293.43",
      "description": "Uncle Frank's Bait Shop"
    }
  ],
  "extra": {
    "account-open-date": 978360153
  }
}
```

### Holdings (SimpleFIN Bridge extension — not in base protocol)

Not documented in the base protocol above, but the SimpleFIN **Bridge** returns a `holdings` array on
investment accounts. Confirmed by the real 2026-06-29 pull (`kumbaradesign.md` §0.3): returned in full
for all investment accounts with **underscore-cased** keys `cost_basis, market_value, shares, symbol`
(plus `id`/`description`). Model as observed; do not assume the account-level hyphen convention.

## Custom Currencies

SimpleFIN supports custom currencies (frequent-flyer miles, rewards points, etc.). Custom currencies
are identified by a unique URL. An HTTP GET to the URL returns a JSON object:

| Attribute | Type | Required | Description |
|---|---|---|---|
| name | string | yes | Human-readable name of the currency. |
| abbr | string | yes | Human-readable short name of the currency. |

All strings from these requests must be sanitized when displayed to users.

Example account with a custom currency:

```json
{
  "id": "2930002",
  "name": "Savings",
  "currency": "https://www.example.com/flight-miles",
  "balance": "100.23",
  "available-balance": "75.23",
  "balance-date": 978366153,
  "transactions": []
}
```

`curl https://www.example.com/flight-miles` returns:

```json
{
  "name": "Example Airline Miles",
  "abbr": "miles"
}
```

## Transaction

| Attribute | Type | Required | Description |
|---|---|---|---|
| id | string | yes | Uniquely describes a transaction within an Account. May be reused across accounts, never within an account. |
| posted | UNIX epoch timestamp | yes | When the transaction posted. If pending, this may be `0`. |
| amount | numeric string | yes | Amount. Positive = money deposited into the account. |
| description | string | yes | Human-readable description of the transaction. |
| transacted_at | UNIX epoch timestamp | optional | When the transaction happened. |
| pending | boolean | optional | `true` = not yet posted. Default absent/false = posted. |
| extra | object | optional | Extra transaction-specific data not defined in this standard. Server's choice. |

```json
{
  "id": "12394832938403",
  "posted": 793090572,
  "amount": "-33293.43",
  "description": "Uncle Frank's Bait Shop"
}
```
