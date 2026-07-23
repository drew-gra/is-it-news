/**
 * Editorial-scale measurement sweep. Runs the full preflight across the
 * labeled validation set and reports each site's RSS-feed author/section/item
 * counts next to its news/marketing label, so a distinct-feed-author threshold
 * can be chosen from real separation rather than guessed.
 *
 * Does NOT change scoring — it reads the feed fields gathered in step 1.
 *
 *   npx tsx scripts/l0-feed-sweep.ts [--labels=path.csv] [--concurrency=5]
 */

import { readFileSync, existsSync } from "node:fs";
import { runPreflight } from "../src/preflight";
import { verdictForPreflight } from "../src/preflight-verdicts";

const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;
const LABELS = arg("labels", "scratch/validation/labels.csv");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "5")));

type Row = { host: string; name: string; kind: "news" | "marketing" };

function loadRows(): Row[] {
  const lines = readFileSync(LABELS, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  lines.shift();
  return lines.map((l) => {
    const [host, name, kind] = l.split(",");
    return {
      host: host?.trim() ?? "",
      name: name?.trim() ?? "",
      kind: kind?.trim().toLowerCase() === "marketing" ? "marketing" : "news",
    };
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

type Out = Row & {
  feedFound: boolean;
  authors: number;
  sections: number;
  items: number;
  recent: number;
  fetchCount: number;
  score: number;
  verdict: string;
  // The two step-3 effects: the editorial-scale bonus fired, and/or the
  // single-byline penalty was disproved by the feed.
  bylineBonus: boolean;
  singleBylineDisproved: boolean;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  if (!existsSync(LABELS)) {
    console.error(`No labels at ${LABELS}.`);
    process.exit(1);
  }
  const rows = loadRows();
  const results: Out[] = [];

  await pool(rows, CONCURRENCY, async (r) => {
    try {
      const sig = await runPreflight(r.host);
      const v = verdictForPreflight(sig);
      const ar = sig.articles;
      results.push({
        ...r,
        feedFound: ar.feedUrl !== null,
        authors: ar.feedDistinctAuthors.length,
        sections: ar.feedDistinctSections.length,
        items: ar.feedItemCount,
        recent: ar.feedRecentCount,
        fetchCount: ar.fetchCount,
        score: sig.score,
        verdict: v.finding,
        bylineBonus: sig.reasons.some((x) => x.signal === "rss_feed_bylines"),
        singleBylineDisproved:
          ar.fetchCount > 0 && ar.distinctBylines.length === 1 && ar.feedDistinctAuthors.length >= 2,
      });
    } catch {
      results.push({
        ...r, feedFound: false, authors: 0, sections: 0, items: 0, recent: 0,
        fetchCount: 0, score: 0, verdict: "error", bylineBonus: false, singleBylineDisproved: false,
      });
    }
  });

  results.sort((a, b) => (a.kind === b.kind ? b.authors - a.authors : a.kind === "news" ? -1 : 1));

  console.log(
    `\n${"KIND".padEnd(10)} ${"HOST".padEnd(28)} ${"authors".padStart(7)} ${"score".padStart(5)} ${"verdict".padEnd(11)} step3`,
  );
  console.log("-".repeat(76));
  for (const r of results) {
    const step3 =
      [r.bylineBonus ? "+byline" : "", r.singleBylineDisproved ? "-penalty" : ""]
        .filter(Boolean)
        .join(" ");
    console.log(
      `${r.kind.padEnd(10)} ${r.host.padEnd(28)} ${String(r.authors).padStart(7)} ${String(r.score).padStart(5)} ${r.verdict.padEnd(11)} ${step3}`,
    );
  }

  const news = results.filter((r) => r.kind === "news");
  const mkt = results.filter((r) => r.kind === "marketing");
  const stat = (rs: Out[], pick: (o: Out) => number) => {
    const vals = rs.map(pick);
    return `median ${median(vals)}  max ${Math.max(0, ...vals)}  min ${Math.min(...vals, 0)}`;
  };
  const vcount = (rs: Out[], v: string) => rs.filter((r) => r.verdict === v).length;
  console.log("-".repeat(76));
  console.log(
    `verdicts (news set):       news ${vcount(news, "news")}   borderline ${vcount(news, "borderline")}   not_news ${vcount(news, "not_news")}  (recall = green/total)`,
  );
  console.log(
    `verdicts (marketing set):  news ${vcount(mkt, "news")}   borderline ${vcount(mkt, "borderline")}   not_news ${vcount(mkt, "not_news")}  (news here = false positives)`,
  );
  console.log(
    `step-3 effects fired:      +byline ${results.filter((r) => r.bylineBonus).length}   -penalty ${results.filter((r) => r.singleBylineDisproved).length}`,
  );
  console.log(`feed found:        news ${news.filter((r) => r.feedFound).length}/${news.length}   marketing ${mkt.filter((r) => r.feedFound).length}/${mkt.length}`);
  console.log(`feed authors:      news [${stat(news, (o) => o.authors)}]   marketing [${stat(mkt, (o) => o.authors)}]`);
  console.log(`feed sections:     news [${stat(news, (o) => o.sections)}]   marketing [${stat(mkt, (o) => o.sections)}]`);

  // Threshold sweep on distinct feed authors: how cleanly does authors >= T
  // separate news from marketing?
  console.log("\nDistinct-feed-author threshold sweep (feed authors >= T):");
  console.log("  T   news>=T   marketing>=T   precision");
  for (let T = 2; T <= 12; T++) {
    const n = news.filter((r) => r.authors >= T).length;
    const m = mkt.filter((r) => r.authors >= T).length;
    const p = n + m ? `${Math.round((100 * n) / (n + m))}%` : "—";
    console.log(`  ${String(T).padStart(2)}   ${String(n).padStart(6)}   ${String(m).padStart(12)}   ${p.padStart(9)}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
