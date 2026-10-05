# Is It News?

**Decide, from a URL alone, whether a site is a news outlet.**

`is-it-news` takes a URL and returns a verdict — `news`, `not_news`, or
`borderline` — with a transparent, itemized score breakdown that shows its
work. No API key, no model, no database. It fetches the site, reads its
structure, and scores what it finds.

```ts
import { classify } from "is-it-news";

const result = await classify("https://www.propublica.org");
// {
//   finding: "news",
//   score: 10,
//   confidence: "high",
//   headline: "News-outlet signals present (score 10).",
//   signals: [
//     { signal: "distinct_bylines",       delta: 3, detail: "5 distinct bylines across sampled articles." },
//     { signal: "recent_article_cadence", delta: 2, detail: "3 sampled articles published within 60 days." },
//     { signal: "section_nav",            delta: 2, detail: "4 topical sections in homepage nav." },
//     { signal: "newsroom_pages",         delta: 2, detail: "Newsroom pages present: /about, /staff, /contact." },
//     { signal: "article_discoverability",delta: 1, detail: "3 article-shaped URLs found via rss." },
//     ...
//   ]
// }
```

## Why "is this news?" is genuinely hard

There is no registry of news outlets, no DNS flag, no metadata field that says
"this is journalism." The question has to be answered from public structure
alone, and structure lies in both directions:

- **A one-person WordPress blog and a real newsroom look nearly identical.**
  Both have `NewsArticle` schema markup, section navigation, bylines, and
  recent posts. The only real difference is editorial *scale* — and scale is
  exactly what a single homepage read can't see.
- **Marketing sites impersonate newsrooms.** Corporate sites run `/newsroom`
  and `/press` sections, publish dated "articles," and mark them up with
  article schema. Structurally they pass; editorially they're press releases.
- **Real outlets hide from robots.** Many news sites sit behind bot-walls
  (Cloudflare managed challenges, DataDome) that serve a 403 to any
  non-browser fetcher — so the naive read of a *real* newsroom comes back
  empty, looking like a dead or non-news site.
- **Press-release wires look like news and aren't.** Paid distribution
  (PR Newswire, etc.) is structurally a newsroom but is not earned media.

So a single yes/no is the wrong output. `is-it-news` scores a **stack of
structural signals**, weights them, applies a few hard categorical gates, and
is honest when the evidence is thin — `borderline` is a real verdict, not a
cop-out.

## What it looks at

The classifier fetches the homepage, samples a few article pages, mines the
site's RSS/Atom feed, and cross-references Wikipedia and Wikidata. It scores
roughly two dozen structural signals — schema markup, section navigation,
newsroom pages, byline diversity, publishing cadence, hosting platform,
commerce fingerprints, and feed editorial scale — into a single score.

The signals, weights, gates, and thresholds are in the code:
[`src/preflight.ts`](./src/preflight.ts) (scoring) and
[`src/preflight-verdicts.ts`](./src/preflight-verdicts.ts) (thresholds). The
source is the reference.

## Install

`is-it-news` is not published to npm. Clone it and run it:

```bash
git clone https://github.com/drew-gra/is-it-news.git
cd is-it-news
npm install
```

Requires Node 20+.

## Usage

### Library

To use it from another project, build the clone (`npm run build`) and install
it by path (`npm install ../is-it-news`). The import then resolves:

```ts
import { classify } from "is-it-news";

const result = await classify("nytimes.com");

console.log(result.finding);   // "news" | "not_news" | "borderline"
console.log(result.score);     // number
console.log(result.confidence);// "low" | "medium" | "high"
console.log(result.signals);   // the scored evidence breakdown
console.log(result.raw);       // full raw evidence (homepage capture, samples, feed, wiki lookups)
```

Optional manual overrides (bare root domains; suffix-matched, so an entry
covers its subdomains):

```ts
await classify("example.com", {
  blocklist: ["spam.example"],   // force not_news, no network reads
  allowlist: ["mysmallpaper.org"], // force news over the structural score
});
```

### CLI

```bash
npm run classify -- https://www.propublica.org
```

Prints the verdict and the full scored signal breakdown.

## The verdict vocabulary

| Finding | Meaning |
|---|---|
| `news` | Structural evidence points to a real news outlet. |
| `not_news` | Marketing site, storefront, social platform, personal page, government site, or press-release wire. |
| `borderline` | Genuinely ambiguous, or the site couldn't be read cleanly (bot-wall, empty capture). An honest "we don't know." |

`confidence` (`low` / `medium` / `high`) qualifies how far the score sits from
the decision thresholds.

## Honest limitations

This is a structural heuristic, not an oracle. Known soft spots:

- **Solo publications.** A serious one-person outlet with no discoverable feed
  can't be distinguished from a personal blog on structure alone. Separating
  them needs network-reputation data (who cites this domain?), which is out of
  scope here.
- **Score thresholds are a first calibration**, not a tuned model. Marketing
  sites with a real `/newsroom` can land right at the boundary.
- **JS-only bot-walls** (full Cloudflare managed challenge) defeat every
  server-side fetch, including the RSS fallback. Those return `borderline` —
  correctly refusing to guess rather than false-negative.

`borderline` and `inconclusive`-style outcomes are features. The tool
distinguishes itself by being honest about what's knowable from public signals.

## Provenance

The algorithm began life as the preflight ("is this even a news outlet?")
gate inside [Cited](https://tools.breadandlaw.com/cited), a tool that assesses
whether an outlet's content is accessible to AI platforms. It's been extracted
here as a standalone, dependency-light library.

## License & credit

MIT — see [LICENSE](./LICENSE).

Build on this freely. It's the product of a long effort to get an inherently
fuzzy classification as close to right as public structure allows. If you
improve it — better calibration, network-reputation signals, headless
bot-wall probing — **credit Andrew Graham.**
