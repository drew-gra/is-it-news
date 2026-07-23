const PROTOCOL_RE = /^https?:\/\//i;

export type NormalizedUrl = {
  raw: string;
  rootDomain: string;
  primaryUrl: string;
};

export function normalizeUrl(input: string): NormalizedUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is empty.");
  }

  const withScheme = PROTOCOL_RE.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Could not parse URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }

  // NB: this is the submitted host minus a leading "www.", NOT the registrable
  // domain (eTLD+1). m./blog./www2. subdomains stay distinct, so the same
  // publisher can be assessed under more than one rootDomain, and robots/
  // sitemap fetches target the exact submitted host. Collapsing to eTLD+1 would
  // need a public-suffix list; deferred deliberately.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host || !host.includes(".")) {
    throw new Error("URL hostname is invalid.");
  }

  return {
    raw: input,
    rootDomain: host,
    primaryUrl: `https://${host}`,
  };
}

// Normalize an operator-entered block/allow-list entry to the bare root
// domain the matcher compares against. Operators paste whatever they have
// on hand — a full URL (https://www.prnewsonline.com/), a `www.` host, a
// host with a path — so run every entry through the same normalizer as a
// submitted URL. Returns null for entries too malformed to parse a host
// from; the caller drops those.
export function entryToRootDomain(entry: string): string | null {
  try {
    return normalizeUrl(entry).rootDomain;
  } catch {
    return null;
  }
}
