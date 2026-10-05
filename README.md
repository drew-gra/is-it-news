# Is It News?

Residual code from [Cited](https://tools.breadandlaw.com/cited) that seeks to
algorithmically separate news from everything else. It's provided here under
MIT for anyone working on that particular classification problem.

It returns a verdict — `news`, `not_news`, or `borderline` — with an itemized
score that shows its work. No API key, no model, no database. It runs as a
library or from the command line; there is no hosted instance.

**Status: archived.** Shared as it stands; not maintained.

## Why the problem is hard

There is no registry of news outlets. The answer has to come from a site's
public structure, and structure misleads in both directions:

- A one-person blog and a real newsroom look nearly identical.
- Marketing sites run `/newsroom` sections that pass as journalism.
- Real outlets sit behind bot-walls and read as empty.
- Press-release wires look like news and aren't.

## Run it

```bash
git clone https://github.com/drew-gra/is-it-news.git
cd is-it-news
npm install
npm run classify -- https://www.propublica.org
```

Requires Node 20+. Not published to npm.

## Use it as a library

Build the clone (`npm run build`) and install it by path
(`npm install ../is-it-news`):

```ts
import { classify } from "is-it-news";

const result = await classify("nytimes.com");
result.finding; // "news" | "not_news" | "borderline"
result.signals; // the scored evidence
```

## Where the logic is

Signals and weights: [`src/preflight.ts`](./src/preflight.ts). Thresholds:
[`src/preflight-verdicts.ts`](./src/preflight-verdicts.ts). The source is the
reference.

## License

MIT — see [LICENSE](./LICENSE). If you improve it, credit Andrew Graham.
