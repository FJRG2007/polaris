import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type FormatFilesResult, formatFilesWithLineNumbers } from "./checkout.ts";

/**
 * parses TOC entries like "- src/math.ts → lines 7-42 · diff-<hex>" into structured data.
 */
function parseTocEntries(toc: string) {
  const entries: Array<{ filename: string; startLine: number; endLine: number }> = [];
  for (const line of toc.split("\n")) {
    const match = line.match(/^- (.+) → lines (\d+)-(\d+) · diff-[0-9a-f]+$/);
    if (match) {
      entries.push({
        filename: match[1],
        startLine: parseInt(match[2], 10),
        endLine: parseInt(match[3], 10),
      });
    }
  }
  return entries;
}

// fixture captured by action/scripts/refresh-test-fixtures.ts. running
// the formatter against checked-in JSON keeps this test offline and
// deterministic - re-fetch the fixture (with creds) when GitHub's
// pulls.listFiles response shape changes, then review the snapshot diff.
type DiffFixture = {
  owner: string;
  name: string;
  pullNumber: number;
  files: Parameters<typeof formatFilesWithLineNumbers>[0];
};

function loadFixture<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "__fixtures__", file), "utf-8")) as T;
}

describe("formatFilesWithLineNumbers", () => {
  it("generates accurate TOC line numbers for polaris/test-repo#1", () => {
    const fx = loadFixture<DiffFixture>("polaris-test-repo-pr-1.diff.json");
    const result: FormatFilesResult = formatFilesWithLineNumbers(fx.files);

    expect(result.content.startsWith(result.toc)).toBe(true);

    const contentLines = result.content.split("\n");
    const tocEntries = parseTocEntries(result.toc);
    expect(tocEntries.length).toBeGreaterThan(0);

    for (const entry of tocEntries) {
      // line numbers are 1-indexed, arrays are 0-indexed
      const firstLine = contentLines[entry.startLine - 1];
      expect(firstLine).toBeDefined();
      // first line of each file section should be the diff header
      expect(firstLine).toBe(`diff --git a/${entry.filename} b/${entry.filename}`);

      expect(entry.endLine).toBeLessThanOrEqual(contentLines.length);
    }

    // verify adjacent files don't overlap and are contiguous
    for (let i = 1; i < tocEntries.length; i++) {
      const prev = tocEntries[i - 1];
      const curr = tocEntries[i];
      expect(curr.startLine).toBe(prev.endLine + 1);
    }

    expect(result.toc).toMatchSnapshot("toc");
    expect(result.content).toMatchSnapshot("content");
  });
});
