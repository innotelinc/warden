/**
 * Cosmetic filtering: the ad, not just the request.
 *
 * Blocking a request stops the ad loading but leaves the hole it was going to
 * fill: a 300-pixel slot with nothing in it, which reads as a broken page
 * rather than a clean one. This is the other half of the job — the containers
 * are hidden and the layout closes over them, so the page looks like one that
 * was never built to carry ads.
 *
 * Two rules keep it from breaking pages it should not touch:
 *
 *   - Nothing is loaded or unloaded. Every selector targets an element already
 *     in the document, so a page the filter engine blocked nothing on is not
 *     made worse — hiding a container the network layer never filled is the
 *     same result as leaving it empty, minus the gap.
 *   - The generic list is curated rather than clever. A substring match on
 *     `ad` catches `header`, `shadow` and `download`, and an operator who finds
 *     a site broken by this can put it in compatibility mode, which skips the
 *     whole pass.
 *
 * Pure and shared by the content preload and the tests.
 */

/**
 * Containers only an ad slot uses: the markup the large networks actually
 * ship, plus the class names the common frameworks settle on.
 */
export const GENERIC_SELECTORS: readonly string[] = [
  'ins.adsbygoogle',
  '[id^="google_ads"]',
  '[id*="google_ads_iframe"]',
  '[id^="div-gpt-ad"]',
  '[id^="aswift"]',
  '[data-ad-client]',
  '[data-ad-slot]',
  '[data-google-query-id]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="/pagead/"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="criteo"]',
  'iframe[src*="taboola"]',
  'iframe[src*="outbrain"]',
  '.ad-slot',
  '.ad-unit',
  '.ad-wrapper',
  '.ad-container',
  '.ads-container',
  '.ad-placeholder',
  '.ad-holder',
  '[id*="banner-ad"]',
  '[class*="banner-ad"]',
  '[class*="advertisement" i]',
  '[aria-label*="advertisement" i]'
]

/**
 * Sites whose ad slots are not described by the generic list.
 *
 * These are the container names a reader would recognise — the same page with
 * the same article and no reserved space — and they are deliberately narrow:
 * a site goes here when the generic list leaves a visible gap, not because it
 * happens to carry advertising.
 */
export const SITE_SELECTORS: Record<string, readonly string[]> = {
  'yahoo.com': [
    '[id^="ad-"]',
    '[class^="ad-"]',
    '[class*="-ad-"]',
    '[id*="-ad-"]',
    '[data-col="ad"]',
    '[data-testid*="ad-"]',
    '[class*="AdUnit"]',
    '[id*="AdWrapper"]',
    '.darla'
  ],
  'msn.com': ['[id^="adsWrapper"]', '[class*="ad-slot"]', '[data-ad]'],
  'forbes.com': ['[class*="ad-unit"]', '[id*="ad-unit"]', '.article-body-ad'],
  'cnn.com': ['[data-component-name*="ad"]'],
  'dailymail.co.uk': ['[class*="ad-slot"]', '[id*="ad-slot"]'],
  'weather.com': ['[id^="ad-"]', '[class*="ad-slot"]']
}

/**
 * Every selector that applies to this host.
 *
 * Matched on the registrable-ish boundary rather than `endsWith` alone, so
 * `notyahoo.com` is not treated as Yahoo.
 */
export function cosmeticSelectorsFor(host: string): string[] {
  const clean = (host || '').toLowerCase().replace(/\.$/, '')
  const extra: string[] = []
  if (clean) {
    for (const [suffix, selectors] of Object.entries(SITE_SELECTORS)) {
      if (clean === suffix || clean.endsWith(`.${suffix}`)) extra.push(...selectors)
    }
  }
  return [...GENERIC_SELECTORS, ...extra]
}

/** The stylesheet the preload writes into the page. */
export function cosmeticCss(host: string): string {
  return cosmeticSelectorsFor(host)
    .map((selector) => `${selector}{display:none !important}`)
    .join('\n')
}
