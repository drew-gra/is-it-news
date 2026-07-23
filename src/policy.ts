// Fetch politeness and user-agent strings for the classifier's network reads
// (homepage, RSS/Atom feed, sitemap, sampled article pages, Wikipedia/Wikidata).

export const POLITENESS = {
  perDomainRequestsPerSecond: 1,
  fetchTimeoutMs: 8_000,
} as const;

// The identifying UA the classifier sends on its own requests. Override with
// the IS_IT_NEWS_USER_AGENT env var to point at your deployment.
export function userAgent(): string {
  return (
    process.env.IS_IT_NEWS_USER_AGENT ??
    "IsItNewsBot/1.0 (+https://github.com/drew-gra/is-it-news)"
  );
}

// Baseline browser UA used for sitemap, feed, and article-URL discovery so
// WAFs that drop a bot UA don't make the classifier false-negative before it
// has read anything.
//
// KEEP THIS CURRENT. Modern edge WAFs (Cloudflare et al.) increasingly 403 a
// stale Chrome version as a likely bot — observed live on prnewsonline.com,
// whose /feed/ served 200 to a current Chrome but 403'd an old Chrome/120
// string, which silently defeated the RSS-feed fallback. Bump the major
// version periodically (a year-plus behind is the danger zone).
export const BASELINE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
