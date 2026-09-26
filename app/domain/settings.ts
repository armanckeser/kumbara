// App settings — a generic key/value preference store, defined once and shared by the server upsert
// and the browser's Electric collection (R8: one schema, no FE/server drift).
//
// The DB row is intentionally generic (key + opaque string value) so N future preferences live in one
// table. Each preference's ALLOWED values are a domain enum validated at the consumption boundary, not
// a column constraint — that keeps "flags are enums, not booleans" (R8) on the read side without a
// column-per-preference explosion.

import { Schema } from "effect";

/**
 * How monetary amounts are displayed across the app:
 *   - "signed"     → -$58.50 / +$120.00 (explicit sign)
 *   - "accounting" → ($58.50) for outflows, $120.00 for inflows (finance-native; the default)
 *   - "color"      → $58.50 with no sign; color alone distinguishes out (red) from in (green)
 */
export const AmountStyle = Schema.Literals(["signed", "accounting", "color"]);
export type AmountStyle = typeof AmountStyle.Type;

/** The setting key the amount style is stored under. */
export const AMOUNT_STYLE_KEY = "amount_style";

/** The fallback when no setting row has streamed yet (matches the 0002_settings migration seed). */
export const DEFAULT_AMOUNT_STYLE: AmountStyle = "accounting";

/** A settings row exactly as Electric streams it / the server upserts it. Validated at both boundaries. */
export class SettingsRow extends Schema.Class<SettingsRow>("kumbara/SettingsRow")({
  key: Schema.String,
  value: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
