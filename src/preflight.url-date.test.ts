import { describe, it, expect } from "vitest";
import { extractDateFromUrl } from "./preflight";

describe("extractDateFromUrl", () => {
  it("reads /YYYY-MM-DD/ permalinks (odwyerpr.com shape)", () => {
    expect(
      extractDateFromUrl(
        "https://www.odwyerpr.com/story/public/24950/2026-06-26/suny-morrisville-needs-enrollment-support.html",
      ),
    ).toBe("2026-06-26T00:00:00Z");
  });

  it("reads /YYYY/MM/DD/ permalinks (WordPress shape)", () => {
    expect(
      extractDateFromUrl("https://example.com/2025/11/03/some-headline/"),
    ).toBe("2025-11-03T00:00:00Z");
  });

  it("does not match bare numeric IDs or year-only paths", () => {
    expect(extractDateFromUrl("https://example.com/story/24950/slug")).toBeNull();
    expect(extractDateFromUrl("https://example.com/2026/archive")).toBeNull();
  });

  it("rejects impossible months and days", () => {
    expect(extractDateFromUrl("https://example.com/2026-13-01/x")).toBeNull();
    expect(extractDateFromUrl("https://example.com/2026-06-40/x")).toBeNull();
  });

  it("returns null for non-URLs and dateless paths", () => {
    expect(extractDateFromUrl("not a url")).toBeNull();
    expect(extractDateFromUrl("https://example.com/about/")).toBeNull();
  });
});
