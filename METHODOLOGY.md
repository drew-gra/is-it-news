# Methodology

`is-it-news` answers a question with no ground truth — *is this URL a news
outlet?* — from public structure alone. It does this with a **scored ensemble
of independent signals**, not a machine-learned model. Each signal contributes
a small positive or negative delta to a running score; a handful of hard
categorical **gates** can override the score outright; thresholds map the final
score to `news` / `borderline` / `not_news`.

Rule-based, not learned, on purpose:

- There is no labeled corpus of "news / not-news" URLs to train on.
- Rule-based decisions are **explainable**. Every verdict ships its itemized
  reasons — "5 distinct bylines (+3), section nav (+2), newsroom pages (+2)" —
  which beats "model output 0.73" for a tool whose whole pitch is showing its
  work.

## What gets fetched

For a given root domain, in rough order:

1. **Homepage** (1 fetch) — `og:site_name`, `og:type`, `<meta name=generator>`
   (hosting platform), section-navigation breadth, newsroom-page links,
   commerce fingerprints.
2. **Article samples** (up to ~3 fetches, reusing sitemap/RSS/homepage
   discovery) — JSON-LD `@type` (`NewsArticle` etc.), author metadata,
   published-date metadata.
3. **RSS/Atom feed** (when discoverable) — distinct `<dc:creator>` bylines,
   `<pubDate>` cadence, `<category>` sections. This is the **editorial-scale**
   signal and the **bot-wall fallback**: a feed is a far larger author sample
   than three article pages, and it's often reachable when the HTML is walled.
4. **Wikipedia + Wikidata** (external API) — does an article reference this
   domain, and is the matched entity *typed* as a news organization?

All fetches use a baseline browser user-agent, serialized to 1 request/second
per domain, because UA-keyed WAFs will otherwise 403 a bot UA and make the
whole read false-negative.

## The scored signals

Positive signals (evidence of a real newsroom):

| Signal | Δ | What it means |
|---|---:|---|
| `json_ld_news_article` | +3 | A sampled article carries `NewsArticle`/`ReportageNewsArticle` JSON-LD. |
| `distinct_bylines` | +3 | Two or more distinct bylines across sampled articles. |
| `rss_feed_bylines` | +3 | Feed shows ≥2 distinct authors (broad editorial-scale sample). |
| `wikidata_news_org` | +3 | Wikidata types the matched entity as a news organization. **(also a gate — see below)** |
| `section_nav` | +2 | Multiple topical sections in homepage navigation. |
| `newsroom_pages` | +2 | About / staff / contact / corrections / ethics pages present. |
| `recent_article_cadence` | +2 | Multiple sampled articles published recently. |
| `rss_feed_cadence` | +2 | Recent publishing cadence mined from the feed. |
| `rss_feed_sections` | +2 | Multiple sections mined from the feed. |
| `og_type_article` | +1 | Homepage `og:type` is `article`. |
| `author_metadata` | +1 | Author signals in article metadata / class-name tiers. |
| `article_discoverability` | +1 | Article-shaped URLs found via sitemap / RSS / homepage. |

Negative signals (evidence *against* a newsroom):

| Signal | Δ | What it means |
|---|---:|---|
| `og_type_product` | −3 | Homepage `og:type` is `product` — a storefront. |
| `commerce_fingerprint` | −2 | Shopify / WooCommerce / cart elements detected. |
| `corporate_blog_subdomain` | −2 | Looks like a company blog subdomain, not a publication. |
| `generic_og_site_name` | −2 | Site name is generic/brand-like, not a masthead. |
| `single_byline_only` | −2 | Every sampled article shares one byline (a solo site). |
| `no_author_signal` | −1 | No author metadata found on samples. |
| `no_recent_articles` | −1 | No recently-dated articles among samples. |

The `rss_feed_bylines` (+3) signal is deliberately built to *disprove* a false
`single_byline_only` (−2): three sampled pages can undercount a real
newsroom's authors by bad luck, but the feed rarely does. Validation showed
"≥2 distinct feed authors" cleanly separated real outlets from marketing sites,
so it's scored as a **bonus only, never a penalty** — many real outlets have no
discoverable feed, and absence of a feed is not evidence of not-news.

## The categorical gates (score overrides)

Some findings are decisive regardless of the structural score. They're checked
before the thresholds:

**Hard `not_news`:**

- **Social-media platform** — a Reddit thread or X post is not an editorial
  publication no matter what its HTML looks like. Short-circuits before any
  fetch.
- **Government domain** (`.gov` / `.mil` / `state.us`) — agencies and
  regulators, not editorial media.
- **Press-release wire** — paid distribution (PR Newswire and the like) is not
  earned editorial media.
- **Manual blocklist** — an operator-supplied domain, forced to `not_news`
  with no network reads. Suffix-matched (covers subdomains). Wins any conflict.

**Hard `news`:**

- **Wikidata news-org identity** — if Wikidata *types* the matched entity as a
  news organization, that's high-confidence news even if the structural score
  is only modest (a real outlet that reads thin on structure — e.g. a
  redesign — must still classify green once its identity is confirmed).
- **Newsletter platform** — Substack / Beehiiv / Ghost require real
  infrastructure to stand up, which rules out the half-hearted marketing case;
  editorial use of them is real journalism, so the platform itself qualifies.
- **Manual allowlist** — an operator-vouched domain, forced to `news` over the
  score and the deny-gates (block still wins a both-listed conflict).

## The "couldn't read the site" path

If the homepage fetch **errors**, or returns 200 but yields a **degenerate,
content-free capture** (the fingerprint of a CDN bot-challenge / JS-only shell
rather than a real read), the on-site signals are untrustworthy. The classifier
falls back to *external* evidence (Wikipedia, sitemap-discovered article
markup, feed):

- score **≥ 3** from external signals → `news` (medium confidence)
- otherwise → `borderline` (low confidence)

This is why a bot-walled real outlet reads `borderline` rather than
`not_news` — the tool refuses to call it non-news when it never actually read
it.

## Thresholds

Once gates and the unreadable-site path are exhausted, the score decides
(green threshold = **5**, calibrated against a labeled validation set on which
marketing sites topped out around 6 and real news clustered at 8+):

| Score | Finding | Confidence |
|---|---|---|
| ≥ 7 | `news` | high |
| 5–6 | `news` | medium |
| 2–4 | `borderline` | medium |
| 0–1 | `not_news` | medium |
| ≤ −2 | `not_news` | high |

The bar is deliberately **permissive** (a low green threshold): the tool was
designed as a preflight gate where *wrongly refusing a real outlet* was the
costly error, so ties break toward `news` / `borderline`.

## Known limitations

These are real, and documented rather than hidden:

- **Solo publications with no feed.** A serious one-person outlet is
  structurally indistinguishable from a personal blog, and `single_byline_only`
  (−2) can't separate them without an editorial-scale signal. When there's no
  discoverable feed to supply that signal, the tool can't push these down
  correctly. Separating them needs **network-reputation data** (does this
  domain get cited by other outlets?), which is out of scope here.
- **Thresholds are a first calibration**, not a tuned model. Marketing sites
  with a genuine `/newsroom` can land right at the green boundary (score 5).
- **JS-only bot-walls** (full Cloudflare managed challenge) defeat every
  server-side fetch, *including* the RSS fallback. Those correctly return
  `borderline` — the tool won't guess.
- **Datacenter-IP edge blocks.** Some WAFs 403 by source-IP reputation, so a
  site readable from a residential IP is unreadable from a datacenter (e.g. a
  cloud host). The read — and thus the verdict — can differ by where it runs.
- **Wikipedia lookup is English-only.** A non-English outlet won't get the
  identity credit even when a matching article exists on another language
  Wikipedia.
- **Newsroom-page detection matches exact paths** (`/about`, `/staff`, …) and
  misses variants like `/about-us`, `/our-team`.

## Where to take it next

The most valuable additions, roughly in order:

1. **Network-reputation signal** — citation/link graph among outlets. This is
   the missing piece for the solo-publication case and probably the single
   biggest accuracy lever.
2. **Threshold calibration against a labeled corpus** — turn the first-guess
   thresholds into tuned ones, or replace the linear score with a learned
   model once labels exist.
3. **Headless bot-wall probing** — a real browser to get past JS challenges,
   converting today's `borderline` bot-walled sites into real reads.
4. **Non-English Wikipedia / newsroom-path variants** — mechanical breadth
   improvements.

If you build any of these, credit Andrew Graham.
