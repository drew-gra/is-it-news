/**
 * Wikidata entity-type lookup — the discriminating upgrade to the plain
 * Wikipedia-presence signal in Layer 0.
 *
 * Wikipedia *presence* measures notability ("is this entity famous?"), which
 * conflates real publications with notable corporations. Wikidata's `instance
 * of` (P31) measures identity ("is this entity a newspaper / magazine / news
 * agency?"), which is what L0 actually wants to know. A notable SaaS company's
 * entity is `instance of: business`; a real outlet's is `instance of:
 * newspaper`. So this turns notability into newsiness.
 *
 * Chain: Wikipedia pageId -> Wikidata QID (via pageprops.wikibase_item) ->
 * P31 claims -> match against NEWS_ORG_TYPES. Fail-open everywhere: any lookup
 * failure or missing entity returns isNewsOrg=false with a non-"found" status,
 * so the caller withholds the bonus rather than penalizing.
 */

import { userAgent } from "./policy";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const TIMEOUT_MS = 5_000;

// P31 (`instance of`) values that mark an editorial news publication.
// Provisional — calibrated against scripts/wikidata-probe.ts output.
export const NEWS_ORG_TYPES: ReadonlyMap<string, string> = new Map([
  ["Q11032", "newspaper"],
  ["Q1153191", "online newspaper"],
  ["Q5276122", "digital newspaper"],
  ["Q192283", "news agency"],
  ["Q41298", "magazine"],
  ["Q1002697", "periodical"],
  ["Q1110794", "daily newspaper"],
  ["Q3917507", "weekly newspaper"],
  ["Q1763090", "alternative newspaper"],
  ["Q17232649", "news website"],
  ["Q738377", "student newspaper"],
  ["Q1616075", "television station"],
  ["Q14350", "radio station"],
  ["Q1061197", "radio network"],
  ["Q1126006", "public broadcaster"],
  ["Q11033", "mass media"],
]);

export type WikidataTypeResult = {
  qid: string | null;
  types: string[]; // P31 QIDs
  typeLabels: string[]; // human-readable, for inspection
  isNewsOrg: boolean;
  status: "found" | "no_entity" | "error";
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function qidForPage(pageId: number): Promise<string | null> {
  const url = `${WIKIPEDIA_API}?action=query&prop=pageprops&ppprop=wikibase_item&pageids=${pageId}&format=json&origin=*`;
  const data = await fetchJson<{
    query?: { pages?: Record<string, { pageprops?: { wikibase_item?: string } }> };
  }>(url);
  const page = data?.query?.pages ? Object.values(data.query.pages)[0] : undefined;
  return page?.pageprops?.wikibase_item ?? null;
}

async function p31Types(qid: string): Promise<string[]> {
  const url = `${WIKIDATA_API}?action=wbgetclaims&entity=${qid}&property=P31&format=json&origin=*`;
  const data = await fetchJson<{
    claims?: { P31?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> };
  }>(url);
  const claims = data?.claims?.P31 ?? [];
  return claims
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter((x): x is string => typeof x === "string");
}

async function labelsFor(qids: string[]): Promise<Record<string, string>> {
  if (qids.length === 0) return {};
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${qids.join("|")}&props=labels&languages=en&format=json&origin=*`;
  const data = await fetchJson<{
    entities?: Record<string, { labels?: { en?: { value?: string } } }>;
  }>(url);
  const out: Record<string, string> = {};
  for (const [id, e] of Object.entries(data?.entities ?? {})) {
    out[id] = e.labels?.en?.value ?? id;
  }
  return out;
}

/**
 * Given a matched Wikipedia pageId, resolve the entity's Wikidata types and
 * whether any is a news-organization type. `withLabels` adds human-readable
 * type names (an extra API call) — useful for the probe, off in production.
 */
export async function lookupWikidataType(
  pageId: number,
  opts: { withLabels?: boolean } = {},
): Promise<WikidataTypeResult> {
  const qid = await qidForPage(pageId);
  if (!qid) {
    return { qid: null, types: [], typeLabels: [], isNewsOrg: false, status: "no_entity" };
  }
  const types = await p31Types(qid);
  const isNewsOrg = types.some((t) => NEWS_ORG_TYPES.has(t));
  const typeLabels = opts.withLabels
    ? await (async () => {
        const labels = await labelsFor(types);
        return types.map((t) => labels[t] ?? t);
      })()
    : types.map((t) => NEWS_ORG_TYPES.get(t) ?? t);
  return { qid, types, typeLabels, isNewsOrg, status: "found" };
}
