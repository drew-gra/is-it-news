import { normalizeUrl } from "./domain";
import { isBlocked, isAllowed } from "./blocklist";
import { runPreflight, type PreflightSignal } from "./preflight";
import {
  verdictForPreflight,
  type PreflightFinding,
  type PreflightConfidence,
  type PreflightReason,
} from "./preflight-verdicts";

export type { PreflightSignal } from "./preflight";
export type {
  PreflightFinding,
  PreflightConfidence,
  PreflightReason,
} from "./preflight-verdicts";

export type ClassifyOptions = {
  // Root domains that force a `not_news` verdict without any network reads.
  // Entries should be bare root domains ("example.com"); block wins a
  // both-listed conflict with the allowlist.
  blocklist?: string[];
  // Root domains that force a `news` verdict over the structural score and the
  // hard categorical gates. The human-override escape hatch.
  allowlist?: string[];
};

export type ClassifyResult = {
  // The submitted URL, verbatim.
  url: string;
  // The host the classifier actually evaluated (submitted host minus `www.`).
  rootDomain: string;
  // The verdict.
  finding: PreflightFinding;
  // A one-line, human-readable explanation of the verdict.
  headline: string;
  // How much to trust the finding.
  confidence: PreflightConfidence;
  // The structural score the verdict thresholds against.
  score: number;
  // The scored signal breakdown — the "shows its work" evidence. Each entry is
  // one structural signal, its point delta, and a plain-English detail.
  signals: PreflightReason[];
  // The full raw evidence object, for callers that want everything the
  // classifier saw (homepage capture, article samples, Wikipedia/Wikidata
  // lookups, feed mining). `null` only if the URL could not be parsed.
  raw: PreflightSignal | null;
};

// Decide, from a URL alone, whether a site is a news outlet.
//
// Pure network-in / verdict-out: fetches the site's homepage, samples a few
// article pages, mines its RSS/Atom feed, and cross-references Wikipedia /
// Wikidata, then scores structural signals into `news` / `not_news` /
// `borderline`. No database, no queue, no persistence.
export async function classify(
  url: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const { rootDomain } = normalizeUrl(url);

  const signal = await runPreflight(rootDomain, { blocklist: opts.blocklist });

  const manuallyBlocked = isBlocked(rootDomain, opts.blocklist ?? []);
  const manuallyAllowed = isAllowed(rootDomain, opts.allowlist ?? []);
  const verdict = verdictForPreflight(signal, manuallyBlocked, manuallyAllowed);

  return {
    url,
    rootDomain,
    finding: verdict.finding,
    headline: verdict.headline,
    confidence: verdict.confidence,
    score: verdict.score,
    signals: verdict.reasons,
    raw: signal,
  };
}
