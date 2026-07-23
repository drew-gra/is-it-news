import { describe, it, expect } from "vitest";
import {
  scorePreflight,
  type PreflightHomepage,
  type PreflightArticles,
} from "./preflight";

function homepage(overrides: Partial<PreflightHomepage> = {}): PreflightHomepage {
  return {
    fetchedUrl: "https://example.com/",
    status: "ok",
    httpStatus: 200,
    ogSiteName: "Example",
    ogType: "website",
    metaGenerator: null,
    sectionNavCount: 0,
    sectionNavSamples: [],
    newsroomLinkCount: 0,
    newsroomLinkSamples: [],
    commerceFingerprints: [],
    ...overrides,
  };
}

function articles(overrides: Partial<PreflightArticles> = {}): PreflightArticles {
  return {
    source: "sitemap",
    sampledUrls: [],
    fetchCount: 0,
    jsonLdNewsArticleCount: 0,
    jsonLdGenericArticleCount: 0,
    distinctBylines: [],
    authorMetaTagHits: 0,
    recentArticleCount: 0,
    feedUrl: null,
    feedItemCount: 0,
    feedDistinctAuthors: [],
    feedRecentCount: 0,
    feedDistinctSections: [],
    ...overrides,
  };
}

function run(args: {
  homepage?: Partial<PreflightHomepage>;
  articles?: Partial<PreflightArticles>;
}) {
  const { reasons, score } = scorePreflight({
    rootDomain: "example.com",
    homepage: homepage(args.homepage),
    articles: articles(args.articles),
    wikipedia: null,
    wikidataNewsOrg: false,
    platform: null,
  });
  return { reasons, score, signals: new Set(reasons.map((r) => r.signal)) };
}

describe("scorePreflight — editorial-scale feed-author signal (rss_feed_bylines)", () => {
  it("fires for a READABLE site when HTML under-sampled bylines but the feed shows 2+", () => {
    const { signals } = run({
      articles: { fetchCount: 3, distinctBylines: ["Solo Writer"], feedDistinctAuthors: ["A", "B", "C"] },
    });
    expect(signals.has("rss_feed_bylines")).toBe(true);
  });

  it("does NOT fire when HTML distinct_bylines already fired (no double-count)", () => {
    const { signals } = run({
      articles: {
        fetchCount: 3,
        distinctBylines: ["Jane Doe", "John Roe"],
        feedDistinctAuthors: ["A", "B", "C"],
      },
    });
    expect(signals.has("distinct_bylines")).toBe(true);
    expect(signals.has("rss_feed_bylines")).toBe(false);
  });

  it("does NOT fire below the 2-author threshold", () => {
    const { signals } = run({
      articles: { fetchCount: 3, distinctBylines: [], feedDistinctAuthors: ["A"] },
    });
    expect(signals.has("rss_feed_bylines")).toBe(false);
  });
});

describe("scorePreflight — single_byline_only is disproved by the feed", () => {
  it("withholds the penalty when the feed shows 2+ distinct authors", () => {
    const { signals } = run({
      articles: {
        fetchCount: 3,
        distinctBylines: ["Solo Writer"],
        feedDistinctAuthors: ["A", "B"],
      },
    });
    expect(signals.has("single_byline_only")).toBe(false);
  });

  it("still applies the penalty when the feed does not disprove it", () => {
    const { signals } = run({
      articles: { fetchCount: 3, distinctBylines: ["Solo Writer"], feedDistinctAuthors: [] },
    });
    expect(signals.has("single_byline_only")).toBe(true);
  });
});

describe("scorePreflight — feed cadence/sections stay bot-walled-only", () => {
  it("does NOT score feed cadence or sections for a readable site", () => {
    const { signals } = run({
      articles: {
        fetchCount: 3,
        feedRecentCount: 20,
        feedDistinctSections: ["A", "B", "C", "D"],
      },
    });
    expect(signals.has("rss_feed_cadence")).toBe(false);
    expect(signals.has("rss_feed_sections")).toBe(false);
  });

  it("DOES score feed cadence/sections when the site is bot-walled (fetchCount 0)", () => {
    const { signals } = run({
      articles: {
        fetchCount: 0,
        feedRecentCount: 20,
        feedDistinctSections: ["A", "B", "C", "D"],
      },
    });
    expect(signals.has("rss_feed_cadence")).toBe(true);
    expect(signals.has("rss_feed_sections")).toBe(true);
  });
});
