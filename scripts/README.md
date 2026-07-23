# scripts/

Diagnostic and evaluation tooling for the classifier. These are the bench tools
used to develop and validate the signal set — they run the scorer statelessly
(no DB, no queue) and are how the score thresholds and the RSS editorial-scale
signal were calibrated. Included here as the record of *how* the algorithm was
interrogated, not just what it decided.

| Script | npm alias | Corpus needed | What it does |
|---|---|---|---|
| `classify.ts` | `npm run classify -- <url>` | none | Classify one URL; print the verdict + scored signal breakdown. |
| `l0-diag.ts` | `npm run diag -- <domain...>` | none | Dump the full raw signal object for one or more domains — every field the scorer saw. The fastest way to see *why* a URL scored the way it did. |
| `triage.ts` | `npm run triage -- --in=urls.txt` | a URL list | Batch-run a list of URLs; write per-host and per-URL CSVs of every signal column. The data-collection pass. |
| `l0-score.ts` | `npm run score -- --in=output.csv` | a triage CSV | Re-score a triage CSV and emit a labeling scaffold. |
| `l0-simulate.ts` | `npm run simulate -- --labels=labels.csv` | a labeled CSV | Replay the scorer over a labeled corpus and report accuracy / confusion against the `news`/`not_news` labels. The threshold-calibration harness. |
| `l0-feed-sweep.ts` | `npm run sweep -- --labels=labels.csv` | a labeled CSV | Sweep the RSS-feed editorial-scale signal (distinct feed authors) across a labeled corpus to measure its separation between real news and marketing. |

## The corpus format

The corpus-consuming scripts (`simulate`, `sweep`, `score`) default to reading
labeled CSVs under a gitignored `scratch/` directory (e.g.
`scratch/validation/labels.csv`) and all guard for the file's absence with a
helpful message. Bring your own labeled set — a CSV of `domain,label` rows
where `label` is `news` or `not_news` — and point the script at it with
`--labels=path.csv`. `triage.ts` bootstraps the collection side from a plain
`urls.txt` (one URL per line).

`classify.ts` and `l0-diag.ts` need no corpus and run against any live URL out
of the box.
