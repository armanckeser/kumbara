// SiteProbe — reads a website's front page, the evidence for a guessed merchant domain.
//
// The automatic domain lookup guesses "<name>.com" for distinctive merchant names and keeps the guess only
// when the site's <title> names the merchant and the page mentions the merchant's city (domain/merchant-
// domain.ts titleNamesMerchant / pageMentionsCity). This service is
// the one place the server reaches out to a merchant's site; it is a service (not a bare fetch) so the
// lookup can be tested against a stub. It never fails: an unreachable, slow, or title-less site is null.

/** What the lookup reads off a site: its title and the head of its HTML. */
export interface SitePage {
  readonly title: string;
  readonly html: string;
}

import { Context, Effect, Layer } from "effect";

/** How long a site gets to answer before the guess is dropped. */
const TIMEOUT_MS = 6000;
/** Only the head of the page is read; the title is near the top. */
const MAX_BYTES = 200_000;

export class SiteProbe extends Context.Service<SiteProbe>()("kumbara/merchants/SiteProbe", {
  make: Effect.succeed({
    /** The site's front page, or null when it can't be read or has no title. */
    page: (_domain: string): Effect.Effect<SitePage | null> => Effect.succeed(null),
  }),
}) {}

const readPage = async (domain: string): Promise<SitePage | null> => {
  const response = await fetch(`https://${domain}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Kumbara merchant logo lookup)" },
  });
  if (!response.ok) return null;
  const html = (await response.text()).slice(0, MAX_BYTES);
  const match = /<title[^>]*>([^<]*)/i.exec(html);
  return match === null ? null : { title: match[1].trim(), html };
};

/** The real probe: an HTTPS GET of the site's front page. */
export const SiteProbeLive = Layer.effect(SiteProbe)(
  Effect.succeed({
    page: (domain: string) =>
      Effect.tryPromise(() => readPage(domain)).pipe(Effect.orElseSucceed(() => null)),
  }),
);
