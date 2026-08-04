import { describe, expect, it } from "vitest";
import { buildLearningsSection, renderLearningsToc } from "./instructions.ts";
import type { LearningsHeading } from "./runContext.ts";

const h = (depth: 1 | 2 | 3 | 4 | 5 | 6, title: string, startLine: number, endLine: number) => ({
  depth,
  title,
  startLine,
  endLine,
});

describe("renderLearningsToc", () => {
  it("renders flat h2 list with parenthesized ranges, no hashes or backticks", () => {
    const headings: LearningsHeading[] = [
      h(2, "Build & test", 1, 18),
      h(2, "Architecture", 19, 60),
    ];
    expect(renderLearningsToc(headings)).toBe(
      `- Build & test (L1-L18)
- Architecture (L19-L60)`
    );
  });

  it("indents deeper headings 2 spaces per depth level past the shallowest", () => {
    const headings: LearningsHeading[] = [
      h(2, "Build & test", 1, 42),
      h(3, "Local", 3, 18),
      h(3, "CI", 19, 42),
      h(2, "Architecture", 43, 210),
      h(3, "Background workers", 80, 210),
    ];
    expect(renderLearningsToc(headings)).toBe(
      `- Build & test (L1-L42)
  - Local (L3-L18)
  - CI (L19-L42)
- Architecture (L43-L210)
  - Background workers (L80-L210)`
    );
  });

  it("treats the shallowest depth as the root column when no h2 is present", () => {
    const headings: LearningsHeading[] = [h(3, "Only h3", 1, 5), h(4, "Sub h4", 2, 5)];
    expect(renderLearningsToc(headings)).toBe(
      `- Only h3 (L1-L5)
  - Sub h4 (L2-L5)`
    );
  });

  it("supports depths up through h6 with stable 2-space indent steps", () => {
    const headings: LearningsHeading[] = [
      h(2, "Two", 1, 10),
      h(3, "Three", 2, 10),
      h(4, "Four", 3, 10),
      h(5, "Five", 4, 10),
      h(6, "Six", 5, 10),
    ];
    expect(renderLearningsToc(headings)).toBe(
      `- Two (L1-L10)
  - Three (L2-L10)
    - Four (L3-L10)
      - Five (L4-L10)
        - Six (L5-L10)`
    );
  });
});

describe("buildLearningsSection", () => {
  it("returns empty string when no file path (seed step failed)", () => {
    expect(buildLearningsSection({ filePath: null, headings: [] })).toBe("");
  });

  it("renders the no-headings affordance when the body has no structure", () => {
    const out = buildLearningsSection({
      filePath: "/tmp/run-1/polaris-learnings.md",
      headings: [],
    });
    expect(out).toContain("************* LEARNINGS *************");
    expect(out).toContain("/tmp/run-1/polaris-learnings.md");
    expect(out).toContain("no headings yet");
    expect(out).toContain("structure it with");
    // does not include a TOC list when there are no headings
    expect(out).not.toMatch(/\(L\d+-L\d+\)/);
  });

  it("intro phrasing does not assert prior runs - works for fresh empty repos too", () => {
    const out = buildLearningsSection({
      filePath: "/tmp/run-1/polaris-learnings.md",
      headings: [],
    });
    // load-bearing: fresh repos have zero previous runs. the prior copy
    // ("accumulated by previous agent runs") was a lie in that case.
    expect(out).not.toContain("accumulated by previous agent runs");
    expect(out).toContain("maintained across runs");
  });

  it("renders the TOC inline with the file path and heading guidance", () => {
    const out = buildLearningsSection({
      filePath: "/tmp/run-1/polaris-learnings.md",
      headings: [h(2, "Build & test", 1, 18), h(2, "Architecture", 19, 60)],
    });
    expect(out).toContain("************* LEARNINGS *************");
    expect(out).toContain("/tmp/run-1/polaris-learnings.md");
    expect(out).toContain("- Build & test (L1-L18)");
    expect(out).toContain("- Architecture (L19-L60)");
    expect(out).toContain("Each range starts at the section heading line");
    // re-read affordance: ranges reflect the run-start snapshot, so the
    // agent needs an explicit nudge to re-read after any mid-run edits.
    // mid-run edits shift the line numbers of every later section, not
    // just the edited one - wording is explicit about that.
    expect(out).toContain("run-start snapshot");
    expect(out).toContain("any edit shifts the line numbers of every later section");
    // explicit "no hashes, no backticks" in the rendered list
    expect(out).not.toContain("- `## Build");
    expect(out).not.toContain("`## Build");
  });
});
