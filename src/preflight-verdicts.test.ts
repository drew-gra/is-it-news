import { describe, it, expect } from "vitest";
import { verdictForPreflight } from "./preflight-verdicts";
import {
  preflightSignalSchema,
  isGovernmentDomain,
  isNewswire,
  type PreflightSignal,
} from "./preflight";

// A healthy, readable news-outlet capture. Tests override only what matters.
function makeSignal(overrides: Partial<PreflightSignal> = {}): PreflightSignal {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    status: "ok",
    homepage: {
      fetchedUrl: "https://example.com/",
      status: "ok",
      httpStatus: 200,
      ogSiteName: "Example",
      ogType: "website",
      metaGenerator: null,
      sectionNavCount: 5,
      sectionNavSamples: ["politics", "business"],
      newsroomLinkCount: 2,
      newsroomLinkSamples: ["/about", "/staff"],
      commerceFingerprints: [],
    },
    articles: {
      source: "sitemap",
      sampledUrls: ["https://example.com/a", "https://example.com/b"],
      fetchCount: 3,
      jsonLdNewsArticleCount: 3,
      jsonLdGenericArticleCount: 0,
      distinctBylines: ["Jane Doe", "John Roe"],
      authorMetaTagHits: 3,
      recentArticleCount: 3,
      feedUrl: null,
      feedItemCount: 0,
      feedDistinctAuthors: [],
      feedRecentCount: 0,
      feedDistinctSections: [],
    },
    wikipedia: null,
    platform: null,
    newsletterPlatformOverride: false,
    socialPlatformDenied: false,
    governmentDenied: false,
    newswireDenied: false,
    wikidataNewsOrg: false,
    score: 9,
    reasons: [],
    ...overrides,
  };
}

// Homepage that returned 200 but yielded no extractable signal — the CDN
// bot-challenge fingerprint.
function degenerateHomepage(): PreflightSignal["homepage"] {
  return {
    fetchedUrl: "https://example.com/",
    status: "ok",
    httpStatus: 200,
    ogSiteName: null,
    ogType: null,
    metaGenerator: null,
    sectionNavCount: 0,
    sectionNavSamples: [],
    newsroomLinkCount: 0,
    newsroomLinkSamples: [],
    commerceFingerprints: [],
  };
}

function emptyArticles(): PreflightSignal["articles"] {
  return {
    source: "none",
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
  };
}

describe("verdictForPreflight — core branches", () => {
  it("null signal => borderline (not yet run)", () => {
    expect(verdictForPreflight(null).finding).toBe("borderline");
  });

  it("high score, readable capture => news", () => {
    expect(verdictForPreflight(makeSignal({ score: 9 })).finding).toBe("news");
  });

  it("mid score (2-4), readable capture => borderline", () => {
    expect(verdictForPreflight(makeSignal({ score: 3 })).finding).toBe(
      "borderline",
    );
  });

  it("low score (<2), readable capture => not_news", () => {
    expect(verdictForPreflight(makeSignal({ score: 0 })).finding).toBe(
      "not_news",
    );
  });

  it("social denylist overrides even a high score => not_news", () => {
    const v = verdictForPreflight(
      makeSignal({ socialPlatformDenied: true, score: 14 }),
    );
    expect(v.finding).toBe("not_news");
  });

  it("newsletter-platform override => news even at low score", () => {
    const v = verdictForPreflight(
      makeSignal({
        newsletterPlatformOverride: true,
        platform: "beehiiv",
        score: 1,
      }),
    );
    expect(v.finding).toBe("news");
  });

  it("homepage error + external evidence (score>=3) => news", () => {
    const v = verdictForPreflight(
      makeSignal({ status: "error", errorMessage: "timeout", score: 3 }),
    );
    expect(v.finding).toBe("news");
  });

  it("homepage error + no external evidence (score<3) => borderline", () => {
    expect(
      verdictForPreflight(makeSignal({ status: "error", score: 0 })).finding,
    ).toBe("borderline");
  });
});

// Regression guard for e29eff1 — the SFGate case. A degenerate capture must
// be treated as "couldn't read the site" and fall back to external evidence,
// NOT scored as if the empty read were real.
describe("degenerate-capture handling (regression: SFGate / e29eff1)", () => {
  it("degenerate capture + external evidence (score>=3) => news", () => {
    const v = verdictForPreflight(
      makeSignal({
        homepage: degenerateHomepage(),
        articles: emptyArticles(),
        wikipedia: {
          queriedTerm: "SFGate",
          status: "found",
          matchedTitle: "SFGate",
          matchedPageId: 123,
        },
        score: 3,
        reasons: [
          { signal: "wikipedia_article", delta: 3, detail: "Wikipedia match." },
        ],
      }),
    );
    expect(v.finding).toBe("news");
    expect(v.headline).toContain("bot challenge");
  });

  it("degenerate capture + no external evidence => borderline (never not_news)", () => {
    const v = verdictForPreflight(
      makeSignal({
        homepage: degenerateHomepage(),
        articles: emptyArticles(),
        wikipedia: null,
        score: 0,
        reasons: [],
      }),
    );
    expect(v.finding).toBe("borderline");
  });

  it("a thin but READABLE homepage is not degenerate (normal scoring applies)", () => {
    // og:site_name present => we genuinely read the page, so a score of 0
    // resolves to not_news rather than the external-evidence fallback.
    const v = verdictForPreflight(
      makeSignal({
        homepage: { ...degenerateHomepage(), ogSiteName: "Thin Site" },
        articles: emptyArticles(),
        score: 0,
      }),
    );
    expect(v.finding).toBe("not_news");
  });
});

// Manual L0 blocklist: when the read-time check tells verdictForPreflight
// the domain is on the blocklist, the verdict is not_news with a neutral
// headline regardless of what the signal contains.
describe("manual L0 blocklist", () => {
  it("manuallyBlocked=true => not_news regardless of a high score", () => {
    const high = makeSignal({ score: 14 });
    const v = verdictForPreflight(high, true);
    expect(v.finding).toBe("not_news");
    expect(v.confidence).toBe("high");
  });

  it("headline is the neutral generic, not the score-based one", () => {
    const v = verdictForPreflight(makeSignal({ score: 14 }), true);
    expect(v.headline).toBe("Not classified as news.");
    // Specifically should NOT mention the score or "signals absent" — the
    // mechanism stays invisible to end users.
    expect(v.headline).not.toMatch(/score/i);
    expect(v.headline).not.toMatch(/signals absent/i);
  });

  it("manuallyBlocked=true with null signal still resolves to not_news", () => {
    expect(verdictForPreflight(null, true).finding).toBe("not_news");
  });

  it("manuallyBlocked=true beats every other rule (social denylist, errors, newsletter)", () => {
    expect(
      verdictForPreflight(makeSignal({ socialPlatformDenied: true }), true)
        .finding,
    ).toBe("not_news");
    expect(
      verdictForPreflight(
        makeSignal({
          newsletterPlatformOverride: true,
          platform: "beehiiv",
          score: 1,
        }),
        true,
      ).finding,
    ).toBe("not_news");
    expect(
      verdictForPreflight(makeSignal({ status: "error", score: 9 }), true)
        .finding,
    ).toBe("not_news");
  });

  it("manuallyBlocked=false (default) leaves the existing logic untouched", () => {
    // Sanity check: passing false (or omitting) the new flag is identical
    // to the pre-blocklist behavior.
    expect(verdictForPreflight(makeSignal({ score: 14 })).finding).toBe("news");
    expect(verdictForPreflight(makeSignal({ score: 14 }), false).finding).toBe(
      "news",
    );
  });
});

// Positive identity gate — Wikidata-confirmed news org => green regardless of
// structural score or the green threshold (the TechCrunch-at-6 case). Deny
// gates and the blocklist still win over it.
describe("Wikidata news-org positive gate", () => {
  it("wikidataNewsOrg => news even below the green threshold", () => {
    expect(
      verdictForPreflight(makeSignal({ wikidataNewsOrg: true, score: 3 })).finding,
    ).toBe("news");
  });

  it("wikidataNewsOrg => news even at a low absolute score", () => {
    const v = verdictForPreflight(makeSignal({ wikidataNewsOrg: true, score: 0 }));
    expect(v.finding).toBe("news");
    expect(v.confidence).toBe("high");
    expect(v.headline).toMatch(/news organization/i);
  });

  it("deny gates still beat the positive gate", () => {
    expect(
      verdictForPreflight(makeSignal({ wikidataNewsOrg: true, governmentDenied: true })).finding,
    ).toBe("not_news");
    expect(
      verdictForPreflight(makeSignal({ wikidataNewsOrg: true, newswireDenied: true })).finding,
    ).toBe("not_news");
  });

  it("manual blocklist still beats the positive gate", () => {
    expect(
      verdictForPreflight(makeSignal({ wikidataNewsOrg: true, score: 14 }), true).finding,
    ).toBe("not_news");
  });
});

// Green threshold is a fixed 5: at or above => news, below => borderline/not_news.
describe("green threshold", () => {
  it("score 5 => news (at the threshold)", () => {
    expect(verdictForPreflight(makeSignal({ score: 5 })).finding).toBe("news");
  });

  it("score 4 => borderline (just below the threshold)", () => {
    expect(verdictForPreflight(makeSignal({ score: 4 })).finding).toBe(
      "borderline",
    );
  });
});

// Government-domain gate — .gov / .mil / state.us are agencies and
// regulators, not editorial publications. Same standing as the social
// denylist: a hard not_news regardless of how news-shaped the HTML looks.
describe("government-domain gate", () => {
  it("governmentDenied overrides even a high score => not_news", () => {
    const v = verdictForPreflight(
      makeSignal({ rootDomain: "cdc.gov", governmentDenied: true, score: 14 }),
    );
    expect(v.finding).toBe("not_news");
    expect(v.confidence).toBe("high");
    expect(v.headline).toContain("government");
  });

  it("isGovernmentDomain matches .gov, .mil, and state.us", () => {
    expect(isGovernmentDomain("cdc.gov")).toBe(true);
    expect(isGovernmentDomain("cannabis.ny.gov")).toBe(true);
    expect(isGovernmentDomain("army.mil")).toBe(true);
    expect(isGovernmentDomain("idph.state.il.us")).toBe(true);
  });

  it("isGovernmentDomain does NOT match commercial .us or lookalikes", () => {
    expect(isGovernmentDomain("formpl.us")).toBe(false);
    expect(isGovernmentDomain("ruralhealth.us")).toBe(false);
    expect(isGovernmentDomain("notgov.com")).toBe(false);
    expect(isGovernmentDomain("mygov.example.com")).toBe(false);
  });

  it("schema defaults governmentDenied to false for older signals", () => {
    const full = makeSignal({ score: 6 });
    const { governmentDenied: _omit, ...oldShape } = full;
    void _omit;
    const result = preflightSignalSchema.safeParse(oldShape);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.governmentDenied).toBe(false);
  });
});

// Newswire gate — paid press-release distribution is not earned media.
describe("newswire gate", () => {
  it("newswireDenied overrides even a high score => not_news", () => {
    const v = verdictForPreflight(
      makeSignal({ rootDomain: "prnewswire.com", newswireDenied: true, score: 11 }),
    );
    expect(v.finding).toBe("not_news");
    expect(v.confidence).toBe("high");
    expect(v.headline).toContain("wire");
  });

  it("isNewswire matches the wires and their country subdomains", () => {
    expect(isNewswire("prnewswire.com")).toBe(true);
    expect(isNewswire("businesswire.com")).toBe(true);
    expect(isNewswire("uk.prnewswire.com")).toBe(true);
    expect(isNewswire("globenewswire.com")).toBe(true);
  });

  it("isNewswire does NOT match editorial PR trade press", () => {
    expect(isNewswire("prweek.com")).toBe(false);
    expect(isNewswire("prnewsonline.com")).toBe(false);
    expect(isNewswire("notprnewswire.example.com")).toBe(false);
  });
});

// Regression guard for 38d798b — strict schemas must tolerate signals
// persisted before socialPlatformDenied existed.
describe("schema back-compat (regression: 38d798b)", () => {
  it("accepts a signal missing socialPlatformDenied, defaulting it to false", () => {
    const full = makeSignal({ score: 6 });
    const { socialPlatformDenied: _omit, ...oldShape } = full;
    void _omit;
    const result = preflightSignalSchema.safeParse(oldShape);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.socialPlatformDenied).toBe(false);
    }
  });
});

describe("manual allowlist override", () => {
  it("forces news on a signal that would otherwise be not_news", () => {
    const signal = makeSignal({ score: 0 }); // would be not_news on score
    const base = verdictForPreflight(signal, false, false);
    expect(base.finding).toBe("not_news");
    const allowed = verdictForPreflight(signal, false, true);
    expect(allowed.finding).toBe("news");
    expect(allowed.confidence).toBe("high");
  });

  it("overrides the hard categorical gates (e.g. newswire)", () => {
    const gated = makeSignal({ score: 0, newswireDenied: true });
    expect(verdictForPreflight(gated, false, false).finding).toBe("not_news");
    expect(verdictForPreflight(gated, false, true).finding).toBe("news");
  });

  it("block beats allow when a domain is on both lists", () => {
    const signal = makeSignal({ score: 9 });
    const both = verdictForPreflight(signal, true, true);
    expect(both.finding).toBe("not_news");
  });
});
