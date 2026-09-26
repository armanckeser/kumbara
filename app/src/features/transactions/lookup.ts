// "What is this?" — turn a raw bank descriptor into a web-search URL the user can open in their own browser
// (Pitch 32 ship-now piece). Pure + exported so the URL-encoding is unit-tested with literal expectations.
//
// R9-safe by construction: this only BUILDS a URL string; opening it happens in the USER's browser with the
// USER's own descriptor. Nothing is sent to the coding agent or company logs. The app never fetches it.

/** A Google search URL for a raw transaction descriptor. The descriptor is url-encoded so spaces, `*`, `&`,
 *  and other reserved characters in POS/ACH strings ("SQ *BLUE BOTTLE", "TST* HATCH & CO") don't break the
 *  query. encodeURIComponent (not encodeURI) so `&`, `=`, `+`, `#`, `?` inside the descriptor are all escaped
 *  rather than treated as query structure. */
export const descriptorSearchUrl = (descriptionRaw: string): string =>
  `https://www.google.com/search?q=${encodeURIComponent(descriptionRaw)}`;
