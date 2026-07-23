import { describe, it, expect } from "vitest";
import { parseFeedItems, extractFeedLinkFromHtml } from "./feed";

// Shaped after thestreet.com's `/.rss/full/` feed: CDATA-wrapped fields,
// <dc:creator> bylines, repeated <category> tags, guid permalink.
const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title><![CDATA[TST (Full)]]></title>
  <item>
    <title><![CDATA[Broadcom, OpenAI deal hit]]></title>
    <link>https://www.thestreet.com/investing/stocks/broadcom-openai-deal</link>
    <guid isPermaLink="true">https://www.thestreet.com/investing/stocks/broadcom-openai-deal</guid>
    <category><![CDATA[Investing]]></category>
    <category><![CDATA[Technology]]></category>
    <dc:creator><![CDATA[Shuning Zhao]]></dc:creator>
    <pubDate>Fri, 26 Jun 2026 01:08:05 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[A new AI bottleneck]]></title>
    <link>https://www.thestreet.com/technology/ai-bottleneck</link>
    <category><![CDATA[Technology]]></category>
    <dc:creator><![CDATA[Daniel Kline]]></dc:creator>
    <pubDate>Thu, 25 Jun 2026 23:30:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>First post</title>
    <link rel="edit" href="https://example.com/edit/1"/>
    <link rel="alternate" type="text/html" href="https://example.com/posts/first"/>
    <author><name>Ada Lovelace</name></author>
    <category term="Engineering"/>
    <category term="Math"/>
    <published>2026-06-20T10:00:00Z</published>
  </entry>
  <entry>
    <title>Second post</title>
    <link href="https://example.com/posts/second"/>
    <author><name>Grace Hopper</name></author>
    <category term="Engineering"/>
    <updated>2026-06-21T10:00:00Z</updated>
  </entry>
</feed>`;

describe("parseFeedItems — RSS", () => {
  const items = parseFeedItems(RSS_FIXTURE);

  it("extracts one item per <item>", () => {
    expect(items).toHaveLength(2);
  });

  it("strips CDATA from dc:creator bylines", () => {
    expect(items.map((i) => i.author)).toEqual(["Shuning Zhao", "Daniel Kline"]);
  });

  it("collects all categories per item, CDATA-stripped", () => {
    expect(items[0].categories).toEqual(["Investing", "Technology"]);
  });

  it("captures link and pubDate", () => {
    expect(items[0].url).toBe(
      "https://www.thestreet.com/investing/stocks/broadcom-openai-deal",
    );
    expect(items[0].publishedAt).toBe("Fri, 26 Jun 2026 01:08:05 GMT");
  });
});

describe("parseFeedItems — Atom", () => {
  const items = parseFeedItems(ATOM_FIXTURE);

  it("falls back to <entry> when there are no <item>s", () => {
    expect(items).toHaveLength(2);
  });

  it("reads the author name, not the wrapping element", () => {
    expect(items.map((i) => i.author)).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  it("prefers the html alternate link over rel=edit", () => {
    expect(items[0].url).toBe("https://example.com/posts/first");
  });

  it("reads category term attributes", () => {
    expect(items[0].categories).toEqual(["Engineering", "Math"]);
  });

  it("uses published, falling back to updated", () => {
    expect(items[0].publishedAt).toBe("2026-06-20T10:00:00Z");
    expect(items[1].publishedAt).toBe("2026-06-21T10:00:00Z");
  });
});

describe("extractFeedLinkFromHtml", () => {
  it("finds an absolute rss alternate href", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" title="RSS" href="https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"/></head>`;
    expect(extractFeedLinkFromHtml(html, "nytimes.com")).toBe(
      "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    );
  });

  it("resolves a relative href against the root domain", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/rss/index.xml"/>`;
    expect(extractFeedLinkFromHtml(html, "theverge.com")).toBe(
      "https://theverge.com/rss/index.xml",
    );
  });

  it("tolerates a missing rel attribute", () => {
    const html = `<link type="application/rss+xml" href="https://example.com/feed"/>`;
    expect(extractFeedLinkFromHtml(html, "example.com")).toBe(
      "https://example.com/feed",
    );
  });

  it("prefers rss over atom when both are present", () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom"/>
      <link rel="alternate" type="application/rss+xml" href="https://example.com/rss"/>`;
    expect(extractFeedLinkFromHtml(html, "example.com")).toBe(
      "https://example.com/rss",
    );
  });

  it("ignores non-alternate rels and non-feed types", () => {
    const html = `
      <link rel="stylesheet" href="/style.css"/>
      <link rel="edituri" type="application/rsd+xml" href="/xmlrpc.php"/>`;
    expect(extractFeedLinkFromHtml(html, "example.com")).toBeNull();
  });
});
