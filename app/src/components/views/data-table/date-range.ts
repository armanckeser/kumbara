// Pure conversion between the two date representations the date-variant range filter juggles (Pitch 30):
//
//   - the STORED/COMPARED value: a sortable YYYYMMDD integer (e.g. 20260701), unchanged from the numeric
//     range machinery so `match`, the dateMin/dateMax URL params, and the Budget month deep-links keep
//     working (summary.ts monthDateBounds emits this same int).
//   - the INPUT value: the "YYYY-MM-DD" string a native <input type="date"> speaks.
//
// This is presentation-format conversion at the input boundary — no business logic (R2), so it lives in the
// shared filter component layer, not the server. Kept pure and dependency-free so it is trivially testable.

/** Encode a YYYYMMDD integer as the "YYYY-MM-DD" string a date input expects. Returns "" for undefined so
 *  a cleared bound renders as an empty field. Zero-pads month/day. */
export function yyyymmddIntToInputValue(value: number | undefined): string {
  if (value === undefined) return "";
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** Decode a date input's "YYYY-MM-DD" string into the YYYYMMDD integer the filter stores. An empty or
 *  malformed string (a half-typed date, a native picker mid-edit, or a browser that hands back garbage)
 *  returns undefined so that bound is CLEARED — never a NaN that would silently reject every row. */
export function inputValueToYyyymmddInt(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  // Reject impossible components (month 00/13, day 00/32) so a typed-but-nonsense date clears rather than
  // producing an int that sorts wrong. Calendar-exact validation (Feb 30) is unnecessary: the value is only
  // a comparison bound, and a slightly-off day still filters sanely.
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return year * 10000 + month * 100 + day;
}

/** Human-readable label for a YYYYMMDD integer bound ("Jul 1, 2026"), shown alongside the input so a
 *  keyboard user sees exactly what the field resolved to. Returns null for an unset bound. */
export function formatYyyymmddInt(value: number | undefined): string | null {
  if (value === undefined) return null;
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  // Construct in UTC and format in UTC so the label never drifts a day across timezones.
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
