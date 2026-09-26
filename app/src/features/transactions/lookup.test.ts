// Regression tests for the "What is this?" descriptor-search URL (Pitch 32 ship-now piece). The one thing a
// wrong URL would hide is bad encoding: a POS/ACH descriptor is full of spaces, `*`, and `&`, and if any of
// those leak into the query unescaped the search breaks (or, worse, `&` splits the query). Black-box: only
// the exported builder is imported; expected URLs are hardcoded literals, never the function re-run on itself.

import { describe, expect, it } from "vitest";
import { descriptorSearchUrl } from "./lookup";

describe("descriptorSearchUrl", () => {
  it("url-encodes spaces and the POS asterisk into a Google search URL", () => {
    // Regression: "SQ *BLUE BOTTLE" must become q=SQ%20*BLUE%20BOTTLE — spaces as %20 (asterisk is an
    // encodeURIComponent literal). A raw space would break the URL.
    expect(descriptorSearchUrl("SQ *BLUE BOTTLE")).toBe(
      "https://www.google.com/search?q=SQ%20*BLUE%20BOTTLE",
    );
  });

  it("escapes an ampersand so it does not split the query string", () => {
    // Negative/boundary: an unescaped `&` in "TST* HATCH & CO" would start a second query param and drop the
    // rest of the descriptor. It must be %26.
    expect(descriptorSearchUrl("TST* HATCH & CO")).toBe(
      "https://www.google.com/search?q=TST*%20HATCH%20%26%20CO",
    );
  });

  it("escapes reserved query characters (=, +, #) that appear in descriptors", () => {
    // Boundary: `=`, `+`, and `#` all have query meaning; each must be percent-escaped so the whole raw
    // string is searched verbatim.
    expect(descriptorSearchUrl("A=1+2 #3")).toBe("https://www.google.com/search?q=A%3D1%2B2%20%233");
  });
});
