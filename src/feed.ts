/**
 * RSS / Atom feed mining for Layer 0 (preflight).
 *
 * A publisher-maintained feed is first-class editorial evidence: it lists
 * recent items with bylines (<dc:creator> / <author>), publish dates
 * (<pubDate> / <published>), and section tags (<category>). Crucially the
 * feed is frequently the ONLY readable surface on a bot-walled outlet —
 * DataDome / Cloudflare-managed-challenge sites (thestreet.com is the
 * canonical case) 403 our fetcher on the homepage, the sitemap, and every
 * article page, but serve the feed without challenge, because feeds exist to
 * be consumed by machines. So when L0's article-HTML sampling comes back
 * empty, the feed is the best — sometimes only — read we get on whether a
 * site is a real, multi-author, actively-publishing news operation.
 *
 * This module does two things sitemap.ts deliberately doesn't:
 *   1. Discovers the feed URL from the homepage <head>
 *      <link rel="alternate" type="application/rss+xml"> — the spec-correct
 *      advertisement — in addition to path guesses.
 *   2. Extracts per-item METADATA (author, categories, date), not just the
 *      article URL. sitemap.ts only needs URLs for L4 to probe; L0 needs the
 *      editorial signals the feed carries.
 *
 * Parsing is regex-based, matching the rest of the codebase's feed handling:
 * feeds are mechanically generated and conform to a narrow schema, so regex
 * is sufficient and avoids an XML dependency.
 */

import { fetchTextWithGzip } from "./sitemap";

export type FeedItem = {
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  categories: string[];
};

export type FeedMineResult = {
  feedUrl: string;
  items: FeedItem[];
};

// Standard feed paths plus `/.rss/full/` — the Arena Group platform
// convention (thestreet.com, parade.com, athlonsports.com, ...), which is not
// reachable from a <link rel="alternate"> when the homepage itself is walled.
const FEED_DISCOVERY_PATHS = [
  "/.rss/full/",
  "/feed/",
  "/feed",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/feed.xml",
  "/index.xml",
];

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const ENTRY_RE = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;

const DC_CREATOR_RE = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i;
// RSS <author> is specced as an email but is widely (mis)used for a name.
const RSS_AUTHOR_RE = /<author\b[^>]*>([\s\S]*?)<\/author>/i;
// Atom: <author><name>…</name></author>.
const ATOM_AUTHOR_NAME_RE =
  /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i;

const RSS_CATEGORY_RE = /<category\b[^>]*>([\s\S]*?)<\/category>/gi;
// Atom categories carry the value in a `term` attribute on a self-closing tag.
const ATOM_CATEGORY_RE = /<category\b[^>]*\bterm=["']([^"']+)["']/gi;

const PUBDATE_RE = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i;
const ATOM_PUBLISHED_RE = /<published\b[^>]*>([\s\S]*?)<\/published>/i;
const ATOM_UPDATED_RE = /<updated\b[^>]*>([\s\S]*?)<\/updated>/i;
const DC_DATE_RE = /<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i;

const RSS_LINK_RE = /<link\b[^>]*>\s*([^<]+?)\s*<\/link>/i;
const GUID_PERMALINK_RE =
  /<guid\b[^>]*\bisPermaLink=["']true["'][^>]*>\s*([^<]+?)\s*<\/guid>/i;
const ATOM_LINK_TAG_RE = /<link\b[^>]*>/gi;

const LINK_TAG_RE = /<link\b[^>]*>/gi;

// Strip a CDATA wrapper, drop any residual tags, decode the handful of HTML
// entities that show up in feed text, and collapse whitespace.
function cleanText(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'");
  return s.replace(/\s+/g, " ").trim();
}

// An Atom <entry> commonly carries several <link>s (rel="edit"/"self"/
// "alternate"). Prefer the HTML alternate (the readable page); per the Atom
// spec a <link> with no rel defaults to "alternate".
function pickAtomLink(entry: string): string | null {
  const links: { href: string; rel: string | null; type: string | null }[] = [];
  for (const m of entry.matchAll(ATOM_LINK_TAG_RE)) {
    const tag = m[0];
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    links.push({
      href,
      rel: tag.match(/\brel=["']([^"']+)["']/i)?.[1] ?? null,
      type: tag.match(/\btype=["']([^"']+)["']/i)?.[1] ?? null,
    });
  }
  if (links.length === 0) return null;
  const alternate = links.find(
    (l) => l.rel === "alternate" || l.type === "text/html",
  );
  const defaultAlternate = links.find((l) => l.rel === null);
  return (alternate ?? defaultAlternate ?? links[0]).href;
}

function parseRssItem(inner: string): FeedItem {
  const author =
    cleanText(inner.match(DC_CREATOR_RE)?.[1]) ||
    cleanText(inner.match(RSS_AUTHOR_RE)?.[1]) ||
    null;
  const categories: string[] = [];
  for (const m of inner.matchAll(RSS_CATEGORY_RE)) {
    const c = cleanText(m[1]);
    if (c) categories.push(c);
  }
  const url =
    cleanText(inner.match(RSS_LINK_RE)?.[1]) ||
    cleanText(inner.match(GUID_PERMALINK_RE)?.[1]) ||
    null;
  const publishedAt =
    cleanText(inner.match(PUBDATE_RE)?.[1]) ||
    cleanText(inner.match(DC_DATE_RE)?.[1]) ||
    null;
  return { url, author, publishedAt, categories };
}

function parseAtomEntry(inner: string): FeedItem {
  const author = cleanText(inner.match(ATOM_AUTHOR_NAME_RE)?.[1]) || null;
  const categories: string[] = [];
  for (const m of inner.matchAll(ATOM_CATEGORY_RE)) {
    const c = cleanText(m[1]);
    if (c) categories.push(c);
  }
  const publishedAt =
    cleanText(inner.match(ATOM_PUBLISHED_RE)?.[1]) ||
    cleanText(inner.match(ATOM_UPDATED_RE)?.[1]) ||
    null;
  return { url: pickAtomLink(inner), author, publishedAt, categories };
}

export function parseFeedItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(ITEM_RE)) items.push(parseRssItem(m[1]));
  if (items.length > 0) return items;
  for (const m of xml.matchAll(ENTRY_RE)) items.push(parseAtomEntry(m[1]));
  return items;
}

// Find a feed URL advertised in the homepage <head> via
// <link rel="alternate" type="application/rss+xml" href="…">. Accepts Atom
// too, prefers RSS, and tolerates the `rel` being absent (some templates emit
// only the type). The href may be relative or point at a different host
// (e.g. rss.nytimes.com), so it is resolved against the homepage URL.
export function extractFeedLinkFromHtml(
  html: string,
  rootDomain: string,
): string | null {
  let rss: string | null = null;
  let atom: string | null = null;
  for (const m of html.slice(0, 256 * 1024).matchAll(LINK_TAG_RE)) {
    const tag = m[0];
    const type = tag.match(/\btype=["']([^"']+)["']/i)?.[1];
    if (!type) continue;
    const isRss = /rss\+xml/i.test(type);
    const isAtom = /atom\+xml/i.test(type);
    if (!isRss && !isAtom) continue;
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    if (rel && !/alternate/i.test(rel)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let resolved: string;
    try {
      resolved = new URL(href, `https://${rootDomain}/`).toString();
    } catch {
      continue;
    }
    if (isRss && !rss) rss = resolved;
    else if (isAtom && !atom) atom = resolved;
  }
  return rss ?? atom;
}

/**
 * Discover and parse the site's feed. Tries, in order: a feed URL already
 * known from sitemap discovery (sample.source === "rss"); the
 * <link rel="alternate"> advertised in the homepage HTML (when readable); then
 * a short list of conventional paths. Returns the first feed that yields at
 * least one item, or null. Fail-soft: any fetch/parse failure just moves on.
 *
 * `tryPaths` (default true) controls the conventional-path stage. Cheap
 * discovery (a known URL, or the homepage <link>) costs one fetch; the path
 * stage can cost up to FEED_DISCOVERY_PATHS fetches of mostly-404s. Callers on
 * a latency-sensitive path that already have the homepage HTML — i.e. readable
 * sites just gathering feed metadata, not rescuing a bot-walled one — pass
 * `tryPaths: false` to skip the expensive guessing.
 */
export async function mineFeed(args: {
  rootDomain: string;
  homepageHtml: string | null;
  knownFeedUrl?: string | null;
  tryPaths?: boolean;
}): Promise<FeedMineResult | null> {
  const tried = new Set<string>();
  const tryUrl = async (url: string): Promise<FeedMineResult | null> => {
    if (tried.has(url)) return null;
    tried.add(url);
    const { text } = await fetchTextWithGzip(url);
    if (!text) return null;
    const items = parseFeedItems(text);
    return items.length > 0 ? { feedUrl: url, items } : null;
  };

  if (args.knownFeedUrl) {
    const r = await tryUrl(args.knownFeedUrl);
    if (r) return r;
  }
  if (args.homepageHtml) {
    const link = extractFeedLinkFromHtml(args.homepageHtml, args.rootDomain);
    if (link) {
      const r = await tryUrl(link);
      if (r) return r;
    }
  }
  if (args.tryPaths ?? true) {
    for (const path of FEED_DISCOVERY_PATHS) {
      const r = await tryUrl(`https://${args.rootDomain}${path}`);
      if (r) return r;
    }
  }
  return null;
}
