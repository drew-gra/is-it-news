/**
 * L0 batch triage — classify a list of URLs as news / not-news using Cited's
 * stateless preflight (Layer 0). No DB, no queue, no Inngest: same
 * runPreflight() the production pipeline uses, called directly.
 *
 * L0 characterizes an OUTLET, not an article, so the runner dedupes the input
 * to unique hostnames (normalizeUrl keeps the full host minus www, so
 * cannabis.ny.gov stays distinct from ny.gov) and runs L0 once per host, then
 * fans the verdict back to every URL on that host. Verdict → color:
 *   news        → GREEN  (meets the news-outlet bar)
 *   borderline  → YELLOW (mixed signals — the manual-review queue)
 *   not_news    → RED    (fails the bar)
 *   error       → GRAY   (couldn't run; left for retry)
 *
 * Because L0's score over-classifies content-marketing service sites as news
 * (they have section nav + NewsArticle markup + bylines), each row also
 * carries triage signals to cut manual review:
 *   read_source  — homepage / external / blocked. "external" or "blocked"
 *                  means we didn't really read the site and the verdict leaned
 *                  on Wikipedia/markup — a fragile basis worth a second look.
 *   commerce     — homepage commerce fingerprints (Shopify, cart, etc.); a
 *                  store/service tell.
 *   newsroom_links — count of about/staff/contact editorial pages found; the
 *                  real boundary between a publication and a marketing blog.
 *   note         — combined flags (commerce; no-newsroom; single-author; ...).
 *
 * Results stream to a CSV as each host completes, and a re-run skips hosts
 * already in that CSV — so a long list is resumable and a crash costs nothing.
 * (If the CSV's header doesn't match this version's columns, it's rewritten.)
 *
 * Two files are written: output.csv (one row per unique host — the analysis
 * view, with signal columns) and output.by-url.csv (every input URL paired
 * with its host's verdict — the deliverable to hand back).
 *
 * Usage:
 *   npm run triage                              # scratch/triage/{input.txt,output.csv}
 *   npm run triage -- --limit=10                # only the first 10 unfinished hosts
 *   npm run triage -- --concurrency=8
 *   npm run triage -- --retry-errors            # re-run only the gray (errored) hosts
 *   npm run triage -- --in=path.txt --out=path.csv
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeUrl } from "../src/domain";
import { runPreflight, type PreflightSignal } from "../src/preflight";
import { verdictForPreflight } from "../src/preflight-verdicts";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

const IN = arg("in", "scratch/triage/input.txt")!;
const OUT = arg("out", "scratch/triage/output.csv")!;
const URLS_OUT = arg("urls", OUT.replace(/\.csv$/i, "") + ".by-url.csv")!;
const LIMIT = Number(arg("limit", "0")); // 0 = all
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "6")));
const RETRY_ERRORS = process.argv.includes("--retry-errors");
const PER_HOST_TIMEOUT_MS = 45_000;

const COLOR = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

type Bucket = "green" | "yellow" | "red" | "gray";
const FINDING_COLOR: Record<string, Bucket> = {
  news: "green",
  borderline: "yellow",
  not_news: "red",
  error: "gray",
};

const HEADERS = [
  "host",
  "color",
  "finding",
  "score",
  "confidence",
  "url_count",
  "read_source",
  "commerce",
  "newsroom_links",
  "distinct_bylines",
  "recent_articles",
  "wiki",
  "note",
  "headline",
  "example_url",
] as const;

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Analysis = {
  readSource: "homepage" | "external" | "blocked";
  commerce: string;
  newsroomLinks: number;
  distinctBylines: number;
  recentArticles: number;
  wiki: boolean;
  note: string;
};

// Mirrors isDegenerateCapture() in preflight-verdicts.ts: a homepage that
// fetched 200 but exposed no extractable signal means we didn't actually read
// the site, so the verdict fell back to external evidence (Wikipedia / sitemap
// markup) — fragile, and the reason notable companies (Calendly, big hospitals)
// get classified as news despite not being publications. Flag it for review.
function analyze(signal: PreflightSignal): Analysis {
  const h = signal.homepage;
  const homepageHasSignal =
    h.ogSiteName !== null ||
    h.ogType !== null ||
    h.metaGenerator !== null ||
    h.sectionNavCount > 0 ||
    h.newsroomLinkCount > 0 ||
    h.commerceFingerprints.length > 0 ||
    signal.platform !== null;
  const readSource: Analysis["readSource"] =
    h.status === "error"
      ? "blocked"
      : !homepageHasSignal && signal.articles.fetchCount === 0
        ? "external"
        : "homepage";

  const newsroomLinks = h.newsroomLinkCount;
  const distinctBylines = signal.articles.distinctBylines.length;

  const flags: string[] = [];
  if (readSource !== "homepage") flags.push("not-read");
  if (h.commerceFingerprints.length > 0) flags.push("commerce");
  if (newsroomLinks === 0) flags.push("no-newsroom");
  if (signal.articles.fetchCount > 0 && distinctBylines <= 1) flags.push("single-author");

  return {
    readSource,
    commerce: h.commerceFingerprints.join(";"),
    newsroomLinks,
    distinctBylines,
    recentArticles: signal.articles.recentArticleCount,
    wiki: signal.wikipedia?.status === "found",
    note: flags.join(";"),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// Fan per-host verdicts back to every input URL, so the operator gets a file
// pairing each source URL with Cited's L0 call. Rebuilt from the full output
// CSV each run; host/color/finding/score are the first four columns and never
// contain commas, so a plain split is safe.
function writeByUrl(perHostPath: string, urlsPath: string, inputLines: string[]) {
  const verdict = new Map<string, { color: string; finding: string; score: string }>();
  if (existsSync(perHostPath)) {
    const rows = readFileSync(perHostPath, "utf8").split("\n").filter(Boolean).slice(1);
    for (const r of rows) {
      const f = r.split(",");
      verdict.set(f[0], { color: f[1], finding: f[2], score: f[3] });
    }
  }
  const out = ["url,host,color,finding,score"];
  for (const line of inputLines) {
    let host = "";
    try {
      host = normalizeUrl(line).rootDomain;
    } catch {
      /* unparseable URL */
    }
    const v = host ? verdict.get(host) : undefined;
    const color = !host ? "invalid_url" : v ? v.color : "pending";
    out.push([line, host, color, v?.finding ?? "", v?.score ?? ""].map(csvEscape).join(","));
  }
  writeFileSync(urlsPath, out.join("\n") + "\n");
}

async function main() {
  if (!existsSync(IN)) {
    console.error(
      `Input not found: ${IN}\nCreate it (one URL per line) — e.g. paste your list into ${IN}.`,
    );
    process.exit(1);
  }

  // 1. Read + dedupe to hostnames, counting URLs per host and keeping an example.
  const lines = readFileSync(IN, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const hosts = new Map<string, { count: number; example: string }>();
  let invalid = 0;
  for (const line of lines) {
    try {
      const { rootDomain } = normalizeUrl(line);
      const cur = hosts.get(rootDomain);
      if (cur) cur.count++;
      else hosts.set(rootDomain, { count: 1, example: line });
    } catch {
      invalid++;
    }
  }

  // 2. Resume: collect hosts already in the output CSV (first column). If the
  //    header doesn't match this version's columns, start fresh.
  mkdirSync(dirname(OUT), { recursive: true });
  const done = new Set<string>();
  const headerLine = HEADERS.join(",");
  const hostOf = (row: string) => row.split(",")[0]?.replace(/^"|"$/g, "") ?? "";
  if (existsSync(OUT)) {
    const content = readFileSync(OUT, "utf8").split("\n").filter(Boolean);
    if (content[0] === headerLine) {
      const rows = content.slice(1);
      if (RETRY_ERRORS) {
        // Drop previously-errored (gray) rows so those hosts re-run; keep the
        // rest verbatim (preserves CSV quoting) and treat them as done. host
        // and color are the first two columns and never contain commas, so a
        // plain split is safe for identifying them.
        const keep = rows.filter((r) => r.split(",")[1] !== "gray");
        const dropped = rows.length - keep.length;
        writeFileSync(OUT, [headerLine, ...keep].join("\n") + "\n");
        for (const r of keep) done.add(hostOf(r));
        if (dropped) console.log(`(--retry-errors: re-running ${dropped} previously errored host(s))`);
      } else {
        for (const r of rows) done.add(hostOf(r));
      }
    } else {
      console.log(`(output schema changed — rewriting ${OUT})`);
      writeFileSync(OUT, headerLine + "\n");
    }
  } else {
    writeFileSync(OUT, headerLine + "\n");
  }

  let pending = [...hosts.keys()].filter((h) => !done.has(h));
  const totalPending = pending.length;
  if (LIMIT > 0) pending = pending.slice(0, LIMIT);

  console.log(
    `\n${lines.length} URLs → ${hosts.size} unique hosts` +
      (invalid ? ` (${invalid} unparseable lines skipped)` : "") +
      `\n${done.size} already done, ${totalPending} pending → running ${pending.length}` +
      ` (concurrency ${CONCURRENCY})\n`,
  );
  if (pending.length === 0) {
    console.log("Nothing to do (all hosts already processed).\n");
    writeByUrl(OUT, URLS_OUT, lines);
    console.log(`Per-URL determinations: ${URLS_OUT}\n`);
    return;
  }

  // 3. Run L0 per host, concurrently, streaming each result to the CSV.
  const tally: Record<Bucket, number> = { green: 0, yellow: 0, red: 0, gray: 0 };
  let n = 0;
  await pool(pending, CONCURRENCY, async (host) => {
    const meta = hosts.get(host)!;
    let finding = "error";
    let score = 0;
    let confidence = "low";
    let headline = "";
    let analysis: Analysis | null = null;
    try {
      const signal = await withTimeout(runPreflight(host), PER_HOST_TIMEOUT_MS);
      const v = verdictForPreflight(signal, false);
      finding = v.finding;
      score = v.score;
      confidence = v.confidence;
      headline = v.headline;
      analysis = analyze(signal);
    } catch (err) {
      headline = err instanceof Error ? err.message : String(err);
    }

    const bucket = FINDING_COLOR[finding] ?? "gray";
    tally[bucket]++;
    appendFileSync(
      OUT,
      [
        host,
        bucket,
        finding,
        score,
        confidence,
        meta.count,
        analysis?.readSource ?? "",
        analysis?.commerce ?? "",
        analysis?.newsroomLinks ?? "",
        analysis?.distinctBylines ?? "",
        analysis?.recentArticles ?? "",
        analysis ? (analysis.wiki ? "yes" : "no") : "",
        analysis?.note ?? "error",
        headline.replace(/\s+/g, " ").trim(),
        meta.example,
      ]
        .map(csvEscape)
        .join(",") + "\n",
    );

    n++;
    const tag = bucket.toUpperCase().padEnd(6);
    const note = analysis?.note ? `  ${COLOR.dim}[${analysis.note}]${COLOR.reset}` : "";
    console.log(
      `${COLOR[bucket]}${tag}${COLOR.reset} ${String(n).padStart(4)}/${pending.length} ` +
        `${host}  ${COLOR.dim}(${finding} ${score}, ${meta.count} url${meta.count === 1 ? "" : "s"})${COLOR.reset}${note}`,
    );
  });

  // 4. Summary.
  console.log(
    `\n${COLOR.green}GREEN ${tally.green}${COLOR.reset}  ` +
      `${COLOR.yellow}YELLOW ${tally.yellow}${COLOR.reset}  ` +
      `${COLOR.red}RED ${tally.red}${COLOR.reset}  ` +
      `${COLOR.gray}GRAY ${tally.gray}${COLOR.reset}` +
      `   (this run: ${pending.length} hosts)\n` +
      `Full results: ${OUT}\n`,
  );

  // 5. Per-URL output — every source URL paired with its L0 verdict.
  writeByUrl(OUT, URLS_OUT, lines);
  console.log(`Per-URL determinations: ${URLS_OUT}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
