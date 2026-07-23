// is-it-news — decide, from a URL alone, whether a site is a news outlet.
//
// Public surface:
//   classify(url, opts?) -> { finding, score, signals, ... }  — the one call.
//
// Lower-level building blocks are re-exported for callers who want the raw
// scorer or the verdict translator directly.

export { classify } from "./classify";
export type {
  ClassifyOptions,
  ClassifyResult,
  PreflightSignal,
  PreflightFinding,
  PreflightConfidence,
  PreflightReason,
} from "./classify";

// Lower-level building blocks.
export { runPreflight, scorePreflight } from "./preflight";
export { verdictForPreflight } from "./preflight-verdicts";
export { normalizeUrl } from "./domain";
export { isBlocked, isAllowed } from "./blocklist";
