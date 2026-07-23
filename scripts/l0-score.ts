/**
 * L0 scoring harness — measure L0 against your manual labels, so every
 * subsequent tweak to the heuristic is evidence-driven rather than guessed.
 *
 * Two steps:
 *
 *   1. Generate a labeling template from a triage run:
 *        npm run l0-score -- --template
 *      Writes scratch/triage/labels.csv = the triage columns + two empty
 *      columns, human_label and reason, sorted greens-first (where L0's false
 *      positives live). Fill human_label with `news` or `not_news` (blank rows
 *      are ignored), and optionally tag reason (government / service-blog /
 *      help-doc / reference / aggregator / other).
 *
 *   2. Score L0 against the filled labels:
 *        npm run l0-score
 *      Prints a confusion matrix, precision/recall for L0's green=news call, a
 *      score-threshold sweep, and a per-signal discrimination table (which
 *      signals actually separate news from not-news in YOUR labels).
 *
 * Reads the triage output CSV for L0's verdict + signal columns; it does NOT
 * re-run L0 (so it's instant and deterministic). Distribution caveat: if your
 * labeled set is the AI-citation corpus, a great threshold here is NOT
 * necessarily a great threshold for L0's real input — use this to find missing
 * signals and validate gates, not to overfit cutoffs.
 *
 * Usage:
 *   npm run l0-score -- --template [--force]
 *   npm run l0-score [--labels=path.csv]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isGovernmentDomain } from "../src/preflight";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
const flag = (n: string) => process.argv.includes(`--${n}`);

const TRIAGE = arg("in", "scratch/triage/output.csv")!;
const LABELS = arg("labels", "scratch/triage/labels.csv")!;

// Minimal RFC-4180-ish CSV: handles quoted fields, doubled quotes, commas.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function normalizeLabel(v: string): "news" | "not_news" | null {
  const s = v.trim().toLowerCase();
  if (["news", "green", "g", "yes", "y"].includes(s)) return "news";
  if (["not_news", "not", "red", "r", "no", "n"].includes(s)) return "not_news";
  return null; // blank, borderline, or unrecognized → excluded
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`;
}
function mean(xs: number[]): string {
  return xs.length === 0 ? "—" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
}

function buildTemplate() {
  if (!existsSync(TRIAGE)) {
    console.error(`Triage output not found: ${TRIAGE}. Run npm run triage first.`);
    process.exit(1);
  }
  if (existsSync(LABELS) && !flag("force")) {
    console.error(`${LABELS} already exists. Use --force to overwrite (loses any labels you've entered).`);
    process.exit(1);
  }
  const rows = parseCsv(readFileSync(TRIAGE, "utf8"));
  const colorRank: Record<string, number> = { green: 0, yellow: 1, gray: 2, red: 3 };
  rows.sort(
    (a, b) =>
      (colorRank[a.color] ?? 9) - (colorRank[b.color] ?? 9) ||
      Number(b.score) - Number(a.score),
  );
  const cols = [
    "host", "color", "score", "read_source", "commerce", "newsroom_links",
    "distinct_bylines", "recent_articles", "wiki", "note", "example_url",
    "human_label", "reason",
  ];
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c] ?? "")).join(","));
  }
  writeFileSync(LABELS, lines.join("\n") + "\n");
  console.log(
    `\nWrote ${rows.length} rows to ${LABELS}, greens first.\n` +
      `Fill human_label (news / not_news) on the rows you have an opinion on; ` +
      `blank rows are ignored.\nThen run: npm run l0-score\n`,
  );
}

function score() {
  if (!existsSync(LABELS)) {
    console.error(`No labels at ${LABELS}. Run: npm run l0-score -- --template`);
    process.exit(1);
  }
  const rows = parseCsv(readFileSync(LABELS, "utf8"));
  type LRow = Record<string, string> & { label: "news" | "not_news" };
  const labeled: LRow[] = rows
    .map((r) => ({ ...r, label: normalizeLabel(r.human_label ?? "") }))
    .filter((r): r is LRow => r.label !== null);

  if (labeled.length === 0) {
    console.error(`No rows have a usable human_label yet in ${LABELS}.`);
    process.exit(1);
  }

  const isNews = (r: { label: string }) => r.label === "news";
  const greenPred = (r: Record<string, string>) => r.color === "green";

  // Confusion matrix: L0 color × human label.
  const cm: Record<string, { news: number; not: number }> = {
    green: { news: 0, not: 0 },
    yellow: { news: 0, not: 0 },
    red: { news: 0, not: 0 },
    gray: { news: 0, not: 0 },
  };
  for (const r of labeled) (cm[r.color] ??= { news: 0, not: 0 })[isNews(r) ? "news" : "not"]++;

  const tp = labeled.filter((r) => greenPred(r) && isNews(r)).length;
  const fp = labeled.filter((r) => greenPred(r) && !isNews(r)).length;
  const fn = labeled.filter((r) => !greenPred(r) && isNews(r)).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(`\nL0 scored against ${labeled.length} labeled hosts (news=${labeled.filter(isNews).length}, not_news=${labeled.length - labeled.filter(isNews).length}).\n`);

  console.log("Confusion matrix (L0 verdict × your label)");
  console.log("  L0       your:news   your:not_news");
  for (const c of ["green", "yellow", "red", "gray"]) {
    if (cm[c].news + cm[c].not === 0) continue;
    console.log(`  ${c.padEnd(8)} ${String(cm[c].news).padStart(9)}   ${String(cm[c].not).padStart(13)}`);
  }
  console.log(
    `\nTreating L0 green = "news":` +
      `\n  precision ${(100 * precision).toFixed(0)}%  (of greens, how many you call news)` +
      `\n  recall    ${(100 * recall).toFixed(0)}%  (of your news, how many L0 greened)` +
      `\n  F1        ${(100 * f1).toFixed(0)}%`,
  );

  // Score-threshold sweep.
  console.log("\nScore-threshold sweep (predicted news = score >= cutoff)");
  console.log("  cutoff   precision   recall   F1");
  for (let cut = -1; cut <= 12; cut++) {
    const t = labeled.filter((r) => Number(r.score) >= cut && isNews(r)).length;
    const f = labeled.filter((r) => Number(r.score) >= cut && !isNews(r)).length;
    const fnn = labeled.filter((r) => Number(r.score) < cut && isNews(r)).length;
    const p = t + f ? t / (t + f) : 0;
    const rc = t + fnn ? t / (t + fnn) : 0;
    const ff = p + rc ? (2 * p * rc) / (p + rc) : 0;
    console.log(`  ${String(cut).padStart(6)}   ${pct(t, t + f).padStart(9)}   ${pct(t, t + fnn).padStart(6)}   ${(100 * ff).toFixed(0).padStart(2)}%`);
  }

  // Per-signal discrimination: how each captured signal differs by label.
  const news = labeled.filter(isNews);
  const not = labeled.filter((r) => !isNews(r));
  const num = (rs: typeof labeled, k: string) => rs.map((r) => Number(r[k]) || 0);

  console.log("\nSignal discrimination (value for your-news vs your-not_news — big gaps = useful signal)");
  console.log(`  newsroom_links (mean)      news ${mean(num(news, "newsroom_links"))}   not ${mean(num(not, "newsroom_links"))}`);
  console.log(`  distinct_bylines (mean)    news ${mean(num(news, "distinct_bylines"))}   not ${mean(num(not, "distinct_bylines"))}`);
  console.log(`  recent_articles (mean)     news ${mean(num(news, "recent_articles"))}   not ${mean(num(not, "recent_articles"))}`);
  console.log(`  wiki = yes                 news ${pct(news.filter((r) => r.wiki === "yes").length, news.length)}   not ${pct(not.filter((r) => r.wiki === "yes").length, not.length)}`);
  console.log(`  commerce present           news ${pct(news.filter((r) => r.commerce !== "").length, news.length)}   not ${pct(not.filter((r) => r.commerce !== "").length, not.length)}`);
  console.log(`  read_source = homepage     news ${pct(news.filter((r) => r.read_source === "homepage").length, news.length)}   not ${pct(not.filter((r) => r.read_source === "homepage").length, not.length)}`);

  // Government gate coverage on the labeled set.
  const govNotNews = not.filter((r) => isGovernmentDomain(r.host)).length;
  const govNews = news.filter((r) => isGovernmentDomain(r.host)).length;
  console.log(`\nGovernment gate on labeled set: catches ${govNotNews} of ${not.length} not_news; wrongly catches ${govNews} of your news (should be 0).`);

  // Reason histogram among false positives (greens you called not_news).
  const fps = labeled.filter((r) => greenPred(r) && !isNews(r) && (r.reason ?? "").trim());
  if (fps.length) {
    const hist: Record<string, number> = {};
    for (const r of fps) hist[r.reason.trim()] = (hist[r.reason.trim()] ?? 0) + 1;
    console.log("\nFalse-positive reasons (greens you flipped to not_news, by tag)");
    for (const [k, v] of Object.entries(hist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
  }
  console.log("");
}

if (flag("template")) buildTemplate();
else score();
