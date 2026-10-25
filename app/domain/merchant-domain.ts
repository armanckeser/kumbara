// A merchant's website domain — what turns a monogram into the merchant's real logo (its favicon).
//
// The feed never carries one (no descriptor in a year of real data has a ".com"), so a domain is written by
// the user or an agent that looked the merchant up (POST /api/merchants/domain). Whatever they paste —
// "https://www.riversidebistro.com/menu", "RiversideBistro.com" — is reduced to the bare host here, once,
// so the column only ever holds "riversidebistro.com".

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The bare lower-case host of a domain or URL, without "www.", or null when it isn't one. */
export const normalizeDomain = (input: string): string | null => {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return HOST.test(host) ? host : null;
};
