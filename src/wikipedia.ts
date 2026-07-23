/**
 * Wikipedia lookup used as a legitimacy proxy in Layer 0 (preflight).
 *
 * Real news outlets accrue Wikipedia coverage over time; spam blogs and
 * corporate marketing sites generally don't. This signal replaces the
 * domain-authority signal we'd otherwise get from a paid Ahrefs / Moz
 * lookup — same intent, free, and similarly slow-moving.
 *
 * Lookup strategy:
 *  1. Search Wikipedia for the candidate name (og:site_name preferred,
 *     root domain stripped of TLD as fallback).
 *  2. For the top three search results, fetch the article extract
 *     (intro paragraph) via the MediaWiki API.
 *  3. Consider a match when any extract references the root domain
 *     verbatim. Domain reference is the load-bearing signal because
 *     name collisions are common (many words double as both common
 *     nouns and outlet names) but the domain in the article body
 *     is much rarer to coincide.
 *
 * False-negative pattern to be aware of: very-small outlets without
 * Wikipedia coverage will score 0 here — that's intentional, but means
 * Wikipedia presence is a positive signal only, never a counter-signal.
 *
 * Wikipedia's terms of use require a contactable User-Agent. We pass
 * the same userAgent() string the rest of Cited uses.
 */

import { z } from "zod";
import { userAgent } from "./policy";

const WIKIPEDIA_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_FETCH_TIMEOUT_MS = 5_000;
const MAX_RESULTS_TO_VERIFY = 3;

export const wikipediaLookupResultSchema = z.object({
  queriedTerm: z.string(),
  status: z.enum(["found", "not_found", "error"]),
  matchedTitle: z.string().nullable(),
  matchedPageId: z.number().nullable(),
  errorMessage: z.string().optional(),
});

export type WikipediaLookupResult = z.infer<typeof wikipediaLookupResultSchema>;

type SearchResponse = {
  query?: {
    search?: Array<{ title: string; pageid: number }>;
  };
};

type ExtractResponse = {
  query?: {
    pages?: Record<
      string,
      {
        pageid: number;
        title: string;
        extract?: string;
        extlinks?: Array<{ "*"?: string; url?: string }>;
      }
    >;
  };
};

function urlHostMatchesDomain(url: string, rootDomain: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase() === rootDomain.toLowerCase();
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.timeout(WIKIPEDIA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function deriveSearchTerm(args: {
  ogSiteName: string | null;
  rootDomain: string;
}): string {
  if (args.ogSiteName && args.ogSiteName.trim().length > 0) {
    return args.ogSiteName.trim();
  }
  // Strip TLD, replace dashes with spaces, title-case. Imperfect but
  // good enough to feed a Wikipedia full-text search.
  const labelParts = args.rootDomain.split(".");
  const label = labelParts.length > 1 ? labelParts.slice(0, -1).join(" ") : labelParts[0];
  return label
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function lookupWikipedia(args: {
  ogSiteName: string | null;
  rootDomain: string;
}): Promise<WikipediaLookupResult> {
  const queriedTerm = deriveSearchTerm(args);
  if (!queriedTerm) {
    return {
      queriedTerm: "",
      status: "not_found",
      matchedTitle: null,
      matchedPageId: null,
    };
  }

  const searchUrl = `${WIKIPEDIA_SEARCH_URL}?action=query&list=search&srsearch=${encodeURIComponent(
    queriedTerm,
  )}&srlimit=${MAX_RESULTS_TO_VERIFY}&format=json&origin=*`;
  const searchData = await fetchJson<SearchResponse>(searchUrl);
  if (!searchData) {
    return {
      queriedTerm,
      status: "error",
      matchedTitle: null,
      matchedPageId: null,
      errorMessage: "Wikipedia search request failed.",
    };
  }
  const hits = searchData.query?.search ?? [];
  if (hits.length === 0) {
    return {
      queriedTerm,
      status: "not_found",
      matchedTitle: null,
      matchedPageId: null,
    };
  }

  const pageIds = hits.map((h) => h.pageid).join("|");
  // Pull both the intro extract AND the article's external-links list.
  // Wikipedia articles about news outlets almost always link to the
  // outlet's website from the External links section, even when the
  // intro prose never spells out the domain — so extract-only matching
  // misses cases like Ms. (magazine) whose intro doesn't mention
  // msmagazine.com but whose extlinks does.
  // ellimit=max (500) so the domain-match check works on articles with
  // many external citations. Wikipedia articles about major outlets
  // (PBS, NPR, NYT) have hundreds of refs; the outlet's own website
  // typically lives in the External Links section near the end, well
  // past the default ellimit=10 / our prior ellimit=50.
  const extractsUrl = `${WIKIPEDIA_SEARCH_URL}?action=query&prop=extracts|extlinks&exintro=1&explaintext=1&ellimit=max&pageids=${pageIds}&format=json&origin=*`;
  const extractsData = await fetchJson<ExtractResponse>(extractsUrl);
  if (!extractsData) {
    return {
      queriedTerm,
      status: "error",
      matchedTitle: null,
      matchedPageId: null,
      errorMessage: "Wikipedia extracts request failed.",
    };
  }

  const pages = Object.values(extractsData.query?.pages ?? {});
  const needle = args.rootDomain.toLowerCase();
  for (const hit of hits) {
    const page = pages.find((p) => p.pageid === hit.pageid);
    const extract = (page?.extract ?? "").toLowerCase();
    if (extract.includes(needle)) {
      return {
        queriedTerm,
        status: "found",
        matchedTitle: hit.title,
        matchedPageId: hit.pageid,
      };
    }
    // External-links match — the MediaWiki API returns each link as
    // either `{"*": "https://..."}` (older) or `{"url": "https://..."}`
    // depending on format version. Check both shapes.
    for (const link of page?.extlinks ?? []) {
      const url = link.url ?? link["*"] ?? "";
      if (url && urlHostMatchesDomain(url, args.rootDomain)) {
        return {
          queriedTerm,
          status: "found",
          matchedTitle: hit.title,
          matchedPageId: hit.pageid,
        };
      }
    }
  }

  return {
    queriedTerm,
    status: "not_found",
    matchedTitle: null,
    matchedPageId: null,
  };
}
