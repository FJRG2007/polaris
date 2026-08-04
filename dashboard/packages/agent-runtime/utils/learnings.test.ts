import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEARNINGS_FILE_NAME,
  learningsFilePath,
  readLearningsFile,
  seedLearningsFile,
} from "./learnings.ts";

describe("learnings tmpfile round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polaris-learnings-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the verbatim DB body to disk and reads it back unchanged", async () => {
    const current = [
      "## Build & test",
      "",
      "- run tests with `pnpm -r test`",
      "",
      "## Architecture",
      "",
      "- workers in `worker/`",
    ].join("\n");
    const path = await seedLearningsFile({ tmpdir: dir, current });
    expect(path).toBe(learningsFilePath(dir));
    expect(path.endsWith(LEARNINGS_FILE_NAME)).toBe(true);

    expect(await readFile(path, "utf8")).toBe(current);
    expect(await readLearningsFile(path)).toBe(current);
  });

  it("seeds an empty file when the repo has no learnings yet, round-trip is empty string", async () => {
    const path = await seedLearningsFile({ tmpdir: dir, current: null });
    expect(await readFile(path, "utf8")).toBe("");
    expect(await readLearningsFile(path)).toBe("");
  });

  it("returns null when the file is missing (treated as no-change by persist)", async () => {
    expect(await readLearningsFile(learningsFilePath(dir))).toBeNull();
  });

  it("trims trailing whitespace so editor newlines never trigger a spurious PATCH", async () => {
    const current = "## Build & test\n\n- one fact";
    const path = await seedLearningsFile({ tmpdir: dir, current });
    await writeFile(path, `${current}\n\n  `, "utf8");
    expect(await readLearningsFile(path)).toBe(current);
  });

  it("truncates over-cap bodies at the last newline boundary so the next-seed TOC parse stays clean", async () => {
    const padding = `${"x".repeat(80)}\n`.repeat(1300);
    const oversized = `## Build & test\n\n${padding}`;
    const path = await seedLearningsFile({ tmpdir: dir, current: null });
    await writeFile(path, oversized, "utf8");
    const read = await readLearningsFile(path);
    expect(read).toBeTruthy();
    expect(read?.length).toBeLessThanOrEqual(100_000);
    const tailLine = read?.split("\n").pop() ?? "";
    expect(/^x+$/.test(tailLine)).toBe(true);
    expect(tailLine.length).toBe(80);
  });

  it("falls back to a hard truncate when the only newline is far above the cap (giant single line)", async () => {
    const oversized = `## Build & test\n${"x".repeat(110_000)}`;
    const path = await seedLearningsFile({ tmpdir: dir, current: null });
    await writeFile(path, oversized, "utf8");
    const read = await readLearningsFile(path);
    expect(read).toBeTruthy();
    expect(read?.length).toBe(100_000);
    expect(read?.startsWith("## Build & test\n")).toBe(true);
  });

  it("preserves legacy free-text without scaffolding or wrapping", async () => {
    const legacy = "- this is some old free-text bullet\n- another one";
    const path = await seedLearningsFile({ tmpdir: dir, current: legacy });
    expect(await readFile(path, "utf8")).toBe(legacy);
    expect(await readLearningsFile(path)).toBe(legacy);
  });
});
