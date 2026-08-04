import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type FormatReviewDataInput, formatReviewData } from "./reviewComments.ts";

// fixtures captured by action/scripts/refresh-test-fixtures.ts; re-run
// (with creds) when GitHub's review/threads/listFiles response shape
// changes, then review the snapshot diff.
type ReviewFixture = FormatReviewDataInput & {
  owner: string;
  name: string;
};

function loadFixture(file: string): ReviewFixture {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "__fixtures__", file), "utf-8")
  ) as ReviewFixture;
}

describe("formatReviewData", () => {
  it("formats thread blocks with TOC and correct line numbers", () => {
    const fx = loadFixture("polaris-scratch-pr-49-review-3485940013.json");
    const result = formatReviewData(fx);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.formatted.toc).toMatchSnapshot("toc");
    expect(result.formatted.content).toMatchSnapshot("content");
  });

  it("formats body-only review", () => {
    const fx = loadFixture("polaris-scratch-pr-64-review-3531000326.json");
    const result = formatReviewData(fx);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.formatted.toc).toMatchSnapshot("toc");
    expect(result.formatted.content).toMatchSnapshot("content");
  });
});
