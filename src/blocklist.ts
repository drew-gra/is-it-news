/**
 * Suffix-matching domain checks against the manual L0 block / allow lists.
 * Kept as pure functions with no DB or fetch dependencies so they can be
 * reused from runPreflight (write time) and the API routes (read time)
 * without dragging either side into a coupling on db/queries.ts.
 *
 * Match semantics: a candidate matches an entry if it equals the entry OR
 * is a subdomain of it. Adding "examplepropaganda.com" therefore matches
 * both itself and "news.examplepropaganda.com" — outlets can't route
 * around it by switching subdomains. A bare prefix like "notexample.com"
 * does NOT match an entry "example.com": only boundary-delimited
 * subdomains (".example.com") match.
 *
 * Case-insensitive (DNS is case-insensitive).
 */
function matchesDomainList(candidate: string, list: string[]): boolean {
  const lower = candidate.toLowerCase();
  for (const raw of list) {
    const entry = raw.toLowerCase();
    if (!entry) continue;
    if (lower === entry) return true;
    if (lower.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function isBlocked(candidate: string, blocklist: string[]): boolean {
  return matchesDomainList(candidate, blocklist);
}

// Mirror of isBlocked for the operator allowlist — identical suffix-match
// semantics (an entry covers the domain and its subdomains).
export function isAllowed(candidate: string, allowlist: string[]): boolean {
  return matchesDomainList(candidate, allowlist);
}
