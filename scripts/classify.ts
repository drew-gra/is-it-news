// Tiny CLI: classify one URL and print the verdict + scored signal breakdown.
//
//   npm run classify -- https://www.propublica.org
//   npx tsx scripts/classify.ts propublica.org

import { classify } from "../src/index";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run classify -- <url>");
    process.exit(1);
  }

  const result = await classify(url);

  console.log(`\n  ${result.url}`);
  console.log(`  root domain : ${result.rootDomain}`);
  console.log(
    `  verdict     : ${result.finding}  (score ${result.score}, ${result.confidence} confidence)`,
  );
  console.log(`  ${result.headline}\n`);

  if (result.signals.length === 0) {
    console.log("  (no scored signals)\n");
    return;
  }

  console.log("  signals:");
  for (const s of result.signals) {
    const delta = s.delta >= 0 ? `+${s.delta}` : `${s.delta}`;
    console.log(`    ${delta.padStart(4)}  ${s.signal} — ${s.detail}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
