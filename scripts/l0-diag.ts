/**
 * L0 diagnostic — runs the full preflight pipeline against one or more domains
 * and dumps the raw signal + computed verdict for each. The single-domain L0
 * companion to scripts/probe.ts (which covers L1/L2/L4). No DB, no queue.
 *
 * Use it to see exactly which signals fired (and which didn't) when a domain
 * scores unexpectedly — including the RSS-feed fallback fields for bot-walled
 * sites.
 *
 * Usage:
 *   npx tsx scripts/l0-diag.ts thestreet.com nytimes.com ...
 */

import { runPreflight } from "../src/preflight";
import { verdictForPreflight } from "../src/preflight-verdicts";

async function main() {
  const domains = process.argv.slice(2);
  for (const d of domains) {
    const sig = await runPreflight(d);
    const v = verdictForPreflight(sig);
    console.log("\n=== " + d + " ===");
    console.log("VERDICT:", v.finding, "score", v.score, "conf", v.confidence);
    console.log("headline:", v.headline);
    console.log("homepage.status:", sig.homepage.status, "http", sig.homepage.httpStatus);
    console.log("ogSiteName:", JSON.stringify(sig.homepage.ogSiteName), "ogType:", sig.homepage.ogType, "generator:", sig.homepage.metaGenerator);
    console.log("sectionNav:", sig.homepage.sectionNavCount, sig.homepage.sectionNavSamples);
    console.log("newsroomLinks:", sig.homepage.newsroomLinkCount, sig.homepage.newsroomLinkSamples);
    console.log("commerce:", sig.homepage.commerceFingerprints);
    console.log("articles.source:", sig.articles.source, "sampled:", sig.articles.sampledUrls.length, "fetched:", sig.articles.fetchCount);
    console.log("  sampledUrls:", sig.articles.sampledUrls);
    console.log("  jsonLdNews:", sig.articles.jsonLdNewsArticleCount, "jsonLdGeneric:", sig.articles.jsonLdGenericArticleCount);
    console.log("  distinctBylines:", sig.articles.distinctBylines);
    console.log("  authorMetaHits:", sig.articles.authorMetaTagHits, "recent:", sig.articles.recentArticleCount);
    console.log("  feed:", sig.articles.feedUrl ?? "(none)", "items:", sig.articles.feedItemCount, "recent:", sig.articles.feedRecentCount);
    console.log("    feedAuthors:", sig.articles.feedDistinctAuthors.length, sig.articles.feedDistinctAuthors.slice(0, 8));
    console.log("    feedSections:", sig.articles.feedDistinctSections.length, sig.articles.feedDistinctSections.slice(0, 8));
    console.log("wikipedia:", JSON.stringify(sig.wikipedia));
    console.log("wikidataNewsOrg:", sig.wikidataNewsOrg);
    console.log("platform:", sig.platform);
    console.log("REASONS:");
    for (const r of sig.reasons) console.log(`  [${r.delta >= 0 ? "+" : ""}${r.delta}] ${r.signal}: ${r.detail}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
