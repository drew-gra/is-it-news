/**
 * Preflight (Layer 0) verdict vocabulary. Deliberately separate from
 * `LayerFinding` because "is this a news outlet?" is a different question
 * than "is this site permissive or restrictive to AI bots?". Conflating
 * the two vocabularies would force one to lie about what it's saying.
 *
 * Three states:
 *  - news        — meets the news-outlet bar; full L1-L5 assessment runs.
 *  - borderline  — weak signals but not absent; assessment runs with a
 *                  warning banner so the user can decide whether the
 *                  result is interesting.
 *  - not_news    — fails the bar; L1-L5 are skipped entirely. The user
 *                  sees the preflight evidence and a refusal explanation.
 *
 * Translator is a pure function over the persisted L0 signal — same
 * shape and contract as the LayerFinding translators in verdicts.ts.
 */
import { z } from "zod";
import type { PreflightSignal } from "./preflight";

export const preflightFindingSchema = z.enum([
  "news",
  "borderline",
  "not_news",
]);
export const preflightConfidenceSchema = z.enum(["low", "medium", "high"]);

export const preflightReasonSchema = z.object({
  signal: z.string(),
  delta: z.number(),
  detail: z.string(),
});

export const preflightVerdictSchema = z.object({
  finding: preflightFindingSchema,
  headline: z.string(),
  confidence: preflightConfidenceSchema,
  score: z.number(),
  reasons: z.array(preflightReasonSchema),
});

export type PreflightFinding = z.infer<typeof preflightFindingSchema>;
export type PreflightConfidence = z.infer<typeof preflightConfidenceSchema>;
export type PreflightReason = z.infer<typeof preflightReasonSchema>;
export type PreflightVerdict = z.infer<typeof preflightVerdictSchema>;

// A "degenerate" capture is one where the homepage fetch reported success
// (status "ok") but produced no extractable signal whatsoever AND no
// articles were discoverable. That is the fingerprint of a CDN bot-challenge
// or JS-only shell served to our fetcher rather than a real read of the site
// (e.g. SFGate behind Hearst's CDN serving an interstitial). Any genuine
// homepage — news or not — exposes at least one of these markers, so their
// total absence means we didn't actually read the page and the on-site
// score is untrustworthy. Detected on read so a previously-degenerate
// capture self-corrects without re-assessment.
function isDegenerateCapture(signal: PreflightSignal): boolean {
  const h = signal.homepage;
  if (h.status !== "ok") return false;
  const homepageHasSignal =
    h.ogSiteName !== null ||
    h.ogType !== null ||
    h.metaGenerator !== null ||
    h.sectionNavCount > 0 ||
    h.newsroomLinkCount > 0 ||
    h.commerceFingerprints.length > 0 ||
    signal.platform !== null;
  return !homepageHasSignal && signal.articles.fetchCount === 0;
}

export function verdictForPreflight(
  signal: PreflightSignal | null,
  manuallyBlocked: boolean = false,
  manuallyAllowed: boolean = false,
): PreflightVerdict {
  // Green bar for the L0 gate before the expensive L1-L5 run, where refusing
  // a real outlet is the costly error, so the bar is permissive. Calibrated
  // against the labeled validation set (scripts/l0-simulate.ts): on live
  // Move-2 scores, marketing tops out at 6 and real news clusters at 8+.
  const greenThreshold = 5;
  // Manual blocklist override — checked before EVERYTHING else, including
  // the null-signal branch. The caller computes this from the live
  // manual_blocklist table at read time (not from any persisted field on
  // the signal), so add/remove on the blocklist takes effect immediately
  // for cached and brand-new assessments alike.
  //
  // Headline is deliberately generic — indistinguishable from any other
  // not_news verdict. The result page already hides L0 evidence when
  // preflight is not_news, so the mechanism stays invisible to end users.
  if (manuallyBlocked) {
    return {
      finding: "not_news",
      headline: "Not classified as news.",
      confidence: "high",
      score: signal?.score ?? 0,
      reasons: signal?.reasons ?? [],
    };
  }

  // Manual allowlist override — the mirror of the blocklist, checked second
  // so block always wins a both-listed conflict. An operator-vouched outlet
  // is `news` regardless of score OR the hard categorical gates: this is the
  // deliberate human-override layer for cases the algorithm can't decide
  // (genuine journalism vs. structurally-identical marketing) and for real
  // outlets Cited can't read at all (datacenter-IP edge blocks). Computed
  // from the live manual_allowlist table at read time, so add/remove takes
  // effect immediately for cached and brand-new assessments alike.
  if (manuallyAllowed) {
    return {
      finding: "news",
      headline: "On the operator allow list — treated as a news outlet.",
      confidence: "high",
      score: signal?.score ?? 0,
      reasons: signal?.reasons ?? [],
    };
  }

  if (!signal) {
    return {
      finding: "borderline",
      headline: "Preflight not yet run.",
      confidence: "low",
      score: 0,
      reasons: [],
    };
  }

  // Social-platform denylist is checked first — it overrides every
  // other rule (newsletter override, error path, score thresholds).
  // These domains aren't editorial publications regardless of what
  // their HTML happens to look like, and the v1 product line is
  // explicit about only assessing news outlets.
  if (signal.socialPlatformDenied) {
    return {
      finding: "not_news",
      headline: `${signal.rootDomain} is a social-media platform — not an editorial news publication.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // Government-domain gate — same standing as the social denylist. .gov / .mil
  // / state.us are agencies and regulators, not editorial publications.
  if (signal.governmentDenied) {
    return {
      finding: "not_news",
      headline: `${signal.rootDomain} is a government domain — not an editorial news publication.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // Newswire gate — paid press-release distribution is not earned media.
  if (signal.newswireDenied) {
    return {
      finding: "not_news",
      headline: `${signal.rootDomain} is a press-release wire (paid distribution) — not earned editorial media.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // Positive identity gate — the mirror of the deny-gates above. If Wikidata
  // classifies the matched entity as a news organization, that is
  // high-confidence news regardless of the structural score or the green
  // threshold: a real outlet that scores only modestly on structure
  // (e.g. TechCrunch at 6) must still read green once its identity is
  // confirmed. Marketing/brand sites are not Wikidata-typed as news orgs, so
  // this does not leak them; the manual blocklist (checked first) overrides if
  // an entity is ever mis-typed.
  if (signal.wikidataNewsOrg) {
    return {
      finding: "news",
      headline: `Wikidata classifies ${signal.rootDomain} as a news organization.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // "Couldn't actually read the site." Two shapes collapse here: the
  // homepage fetch errored outright, OR it returned 200 but yielded a
  // degenerate (content-free) capture — the CDN bot-challenge pattern. In
  // both cases the on-site signals are untrustworthy, so we fall back to
  // external evidence (Wikipedia, sitemap-discovered NewsArticle markup)
  // the same way: score >= 3 means something independent of the homepage
  // cleared the bar, so classify as news rather than dumping to borderline.
  const homepageErrored = signal.status === "error";
  const degenerate = isDegenerateCapture(signal);
  if (homepageErrored || degenerate) {
    const why = homepageErrored
      ? `Homepage unreachable (${signal.errorMessage ?? "unknown error"})`
      : "Homepage returned no readable signal (likely a bot challenge)";
    if (signal.score >= 3) {
      return {
        finding: "news",
        headline: `${why}; classified as news on external evidence (score ${signal.score}).`,
        confidence: "medium",
        score: signal.score,
        reasons: signal.reasons,
      };
    }
    return {
      finding: "borderline",
      headline: `${why}; proceeding with caution.`,
      confidence: "low",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // Newsletter-platform override. Substack, Beehiiv, and Ghost require a
  // material infrastructure investment to set up, which rules out the
  // half-hearted corporate-marketing case Cited is trying to filter out.
  // Editorial use of those platforms — opinion journalism, newsletters,
  // aggregation — is real journalism even when the signal stack would
  // otherwise score it borderline, so we treat the platform itself as
  // the qualifying signal.
  if (signal.newsletterPlatformOverride) {
    return {
      finding: "news",
      headline: `${signal.platform ?? "Newsletter platform"} publication — treated as news by policy.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  if (signal.score >= greenThreshold) {
    return {
      finding: "news",
      headline: `News-outlet signals present (score ${signal.score}).`,
      confidence: signal.score >= 7 ? "high" : "medium",
      score: signal.score,
      reasons: signal.reasons,
    };
  }
  if (signal.score >= 2) {
    return {
      finding: "borderline",
      headline: `Mixed news-outlet signals (score ${signal.score}); assessment will proceed but verdict may be noisy.`,
      confidence: "medium",
      score: signal.score,
      reasons: signal.reasons,
    };
  }
  return {
    finding: "not_news",
    headline: `News-outlet signals absent (score ${signal.score}); not classified as a news outlet.`,
    confidence: signal.score <= -2 ? "high" : "medium",
    score: signal.score,
    reasons: signal.reasons,
  };
}
