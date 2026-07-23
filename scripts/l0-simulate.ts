/**
 * Move 2 weight simulation. Runs full L0 over the labeled validation set,
 * then recomputes each verdict two ways WITHOUT touching production scoring:
 *
 *   Design A (replace): drop the +3 Wikipedia-presence credit; award +3 only
 *                       when the matched entity is Wikidata-typed as a news org.
 *   Design B (tier):    same, but presence-without-news-type keeps a small +1.
 *
 * For each host it shows current vs A vs B finding+score, and flags real-news
 * demotions and marketing that stays green — the two things that decide A vs B.
 *
 *   npx tsx scripts/l0-simulate.ts [--labels=path.csv] [--concurrency=5]
 */

import { readFileSync, existsSync } from "node:fs";
import { runPreflight, type PreflightSignal } from "../src/preflight";
import { verdictForPreflight } from "../src/preflight-verdicts";
import { lookupWikidataType } from "../src/wikidata";

const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;
const LABELS = arg("labels", "scratch/validation/labels.csv");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "5")));
const TYPE_CREDIT = 3;

type Row = { host: string; name: string; kind: "news" | "marketing"; note: string };

function loadRows(): Row[] {
  const lines = readFileSync(LABELS, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  lines.shift();
  return lines.map((l) => {
    const [host, name, kind, note] = l.split(",");
    return {
      host: host?.trim() ?? "",
      name: name?.trim() ?? "",
      kind: kind?.trim().toLowerCase() === "marketing" ? "marketing" : "news",
      note: note?.trim() ?? "",
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
  current: string;
  scoreNow: number;
  a: string;
  scoreA: number;
  b: string;
  scoreB: number;
  presence: number;
  newsType: boolean;
};

async function main() {
  if (!existsSync(LABELS)) {
    console.error(`No labels at ${LABELS}.`);
    process.exit(1);
  }
  const rows = loadRows();
  const results: Out[] = [];

  await pool(rows, CONCURRENCY, async (r) => {
    let signal: PreflightSignal;
    try {
      signal = await runPreflight(r.host);
    } catch {
      return;
    }
    const current = verdictForPreflight(signal);
    const presence =
      signal.reasons.find((x) => x.signal === "wikipedia_article")?.delta ?? 0;
    let newsType = false;
    if (signal.wikipedia?.status === "found" && signal.wikipedia.matchedPageId !== null) {
      try {
        newsType = (await lookupWikidataType(signal.wikipedia.matchedPageId)).isNewsOrg;
      } catch {
        /* fail-open */
      }
    }
    const scoreA = signal.score - presence + (newsType ? TYPE_CREDIT : 0);
    const scoreB =
      signal.score - presence + (newsType ? TYPE_CREDIT : presence > 0 ? 1 : 0);
    const a = verdictForPreflight({ ...signal, score: scoreA });
    const b = verdictForPreflight({ ...signal, score: scoreB });
    results.push({
      ...r,
      current: current.finding,
      scoreNow: signal.score,
      a: a.finding,
      scoreA,
      b: b.finding,
      scoreB,
      presence,
      newsType,
    });
  });

  results.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "news" ? -1 : 1));

  const F: Record<string, string> = { news: "GREEN", borderline: "yellow", not_news: "red" };
  console.log(
    `\n${"KIND".padEnd(5)} ${"HOST".padEnd(26)} ${"now".padEnd(7)} ${"A".padEnd(7)} ${"B".padEnd(7)} wiki  type`,
  );
  console.log("-".repeat(78));
  for (const r of results) {
    const mark = (v: string) => (F[v] ?? v).padEnd(7);
    const flag =
      r.kind === "news" && r.current === "news" && r.a !== "news" ? " <- A demotes" : "";
    console.log(
      `${r.kind.padEnd(5)} ${r.host.padEnd(26)} ${mark(r.current)}${mark(r.a)}${mark(r.b)} ` +
        `${r.presence ? "+3" : "  "}   ${r.newsType ? "news" : "-"}${flag}`,
    );
  }

  const tally = (rs: Out[], pick: (o: Out) => string, want: string) =>
    rs.filter((o) => pick(o) === want).length;
  const news = results.filter((r) => r.kind === "news");
  const mkt = results.filter((r) => r.kind === "marketing");
  console.log("-".repeat(78));
  console.log("News outlets shown as GREEN (recall):");
  console.log(
    `  now ${tally(news, (o) => o.current, "news")}/${news.length}` +
      `   A ${tally(news, (o) => o.a, "news")}/${news.length}` +
      `   B ${tally(news, (o) => o.b, "news")}/${news.length}`,
  );
  console.log("Marketing shown as GREEN (false positives — want low):");
  console.log(
    `  now ${tally(mkt, (o) => o.current, "news")}/${mkt.length}` +
      `   A ${tally(mkt, (o) => o.a, "news")}/${mkt.length}` +
      `   B ${tally(mkt, (o) => o.b, "news")}/${mkt.length}`,
  );
  const demoted = news.filter((o) => o.current === "news" && o.a !== "news");
  if (demoted.length) {
    console.log(`\nReal news demoted under Design A (${demoted.length}):`);
    for (const d of demoted)
      console.log(`  ${d.host.padEnd(26)} ${d.note}  (now ${d.scoreNow} -> A ${d.scoreA}: ${d.a})`);
  }

  // Move 1: green-threshold sweep on the LIVE (Move 2) scores. green ~= score>=T.
  console.log("\nGreen-threshold sweep (green = score >= T) on live Move-2 scores:");
  console.log("  T   news GREEN   marketing GREEN   green precision");
  for (let T = 4; T <= 9; T++) {
    const n = news.filter((o) => o.scoreNow >= T).length;
    const m = mkt.filter((o) => o.scoreNow >= T).length;
    const p = n + m ? `${Math.round((100 * n) / (n + m))}%` : "—";
    console.log(
      `  ${T}   ${String(n).padStart(2)}/${news.length}        ${String(m).padStart(2)}/${mkt.length}             ${p}`,
    );
  }

  // Score distribution by class, so the cutoff is visible.
  const dist = (rs: Out[]) =>
    rs
      .map((o) => o.scoreNow)
      .sort((a, b) => b - a)
      .join(" ");
  console.log(`\nnews scores:      ${dist(news)}`);
  console.log(`marketing scores: ${dist(mkt)}`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
