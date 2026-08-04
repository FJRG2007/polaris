import { describe, expect, it } from "vitest";
import { postProcessRangeDiff } from "./rangeDiff.ts";

describe("postProcessRangeDiff", () => {
  it("returns null for identical patches", () => {
    const input = "1:  abc1234 = 1:  def5678 x";
    expect(postProcessRangeDiff(input)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(postProcessRangeDiff("")).toBeNull();
    expect(postProcessRangeDiff("   ")).toBeNull();
  });

  it("returns null when no changes exist between versions", () => {
    const input = [
      "1:  abc1234 ! 1:  def5678 x",
      "     ## src/file.ts ##",
      "     @@ src/file.ts",
      "     +const a = 1;",
      "     +const b = 2;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toBeNull();
  });

  it("strips inner diff prefix from content lines", () => {
    const input = [
      "1:  abc1234 ! 1:  def5678 x",
      "     ## src/math.ts ##",
      "     @@ src/math.ts",
      "     +  const a = 1;",
      "    -+  const b = 2;",
      "    ++  const b = 3;",
      "     +  const c = 4;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/math.ts ##
			 @@ src/math.ts
			   const a = 1;
			-  const b = 2;
			+  const b = 3;
			   const c = 4;"
		`);
  });

  it("handles context lines (inner space prefix)", () => {
    const input = [
      "1:  abc1234 ! 1:  def5678 x",
      "     ## src/file.ts ##",
      "     @@ src/file.ts",
      "      const base = true;",
      "    - const old = true;",
      "    + const new_ = true;",
      "      const end = true;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/file.ts ##
			 @@ src/file.ts
			 const base = true;
			-const old = true;
			+const new_ = true;
			 const end = true;"
		`);
  });

  it("trims context lines around changes", () => {
    const contextBefore = Array.from(
      { length: 9 },
      (_, i) => `     +const line${i + 1} = ${i + 1};`
    );
    const contextAfter = Array.from(
      { length: 6 },
      (_, i) => `     +const line${i + 11} = ${i + 11};`
    );
    const input = [
      "1:  abc1234 ! 1:  def5678 x",
      "     ## src/large.ts ##",
      "     @@ src/large.ts",
      ...contextBefore,
      "    -+const line10 = 10;",
      "    ++const line10 = 100;",
      ...contextAfter,
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/large.ts ##
			 @@ src/large.ts
			...
			 const line7 = 7;
			 const line8 = 8;
			 const line9 = 9;
			-const line10 = 10;
			+const line10 = 100;
			 const line11 = 11;
			 const line12 = 12;
			 const line13 = 13;"
		`);
  });

  it("handles multiple files", () => {
    const input = [
      "1:  abc ! 1:  def x",
      "     ## src/a.ts ##",
      "     @@ src/a.ts",
      "    -+old line a",
      "    ++new line a",
      "     ## src/b.ts ##",
      "     @@ src/b.ts",
      "     +unchanged",
      "    -+old line b",
      "    ++new line b",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/a.ts ##
			 @@ src/a.ts
			-old line a
			+new line a
			 ## src/b.ts ##
			 @@ src/b.ts
			 unchanged
			-old line b
			+new line b"
		`);
  });

  it("handles new file added in new version", () => {
    const input = [
      "1:  abc ! 1:  def x",
      "    +## src/new.ts (new) ##",
      "    +@@ src/new.ts (new)",
      "    ++export const x = 1;",
      "    ++export const y = 2;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			"+## src/new.ts (new) ##
			+@@ src/new.ts (new)
			+export const x = 1;
			+export const y = 2;"
		`);
  });

  it("handles file removed in new version", () => {
    const input = [
      "1:  abc ! 1:  def x",
      "    -## src/old.ts ##",
      "    -@@ src/old.ts",
      "    --export const x = 1;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			"-## src/old.ts ##
			-@@ src/old.ts
			-export const x = 1;"
		`);
  });

  it("filters out metadata section via context trimming", () => {
    const input = [
      "1:  abc ! 1:  def x",
      "     @@ Metadata",
      "      Author: Test <test@test.com>",
      "     ## Commit message ##",
      "        x",
      "     ## src/file.ts ##",
      "     @@ src/file.ts",
      "     +const a = 1;",
      "    -+const b = 2;",
      "    ++const b = 3;",
      "     +const c = 4;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/file.ts ##
			 @@ src/file.ts
			 const a = 1;
			-const b = 2;
			+const b = 3;
			 const c = 4;"
		`);
  });

  it("uses custom context line count", () => {
    const contextBefore = Array.from(
      { length: 5 },
      (_, i) => `     +const line${i + 1} = ${i + 1};`
    );
    const contextAfter = Array.from(
      { length: 5 },
      (_, i) => `     +const line${i + 7} = ${i + 7};`
    );
    const input = [
      "1:  abc1234 ! 1:  def5678 x",
      "     ## src/file.ts ##",
      "     @@ src/file.ts",
      ...contextBefore,
      "    -+const changed = old;",
      "    ++const changed = new;",
      ...contextAfter,
    ].join("\n");
    expect(postProcessRangeDiff(input, 1)).toMatchInlineSnapshot(`
			" ## src/file.ts ##
			 @@ src/file.ts
			...
			 const line5 = 5;
			-const changed = old;
			+const changed = new;
			 const line7 = 7;"
		`);
  });

  it("handles two separate change regions in the same file", () => {
    const middle = Array.from({ length: 10 }, (_, i) => `     +const mid${i + 1} = ${i + 1};`);
    const input = [
      "1:  abc ! 1:  def x",
      "     ## src/file.ts ##",
      "     @@ src/file.ts",
      "    -+const first = old;",
      "    ++const first = new;",
      ...middle,
      "    -+const second = old;",
      "    ++const second = new;",
    ].join("\n");
    expect(postProcessRangeDiff(input)).toMatchInlineSnapshot(`
			" ## src/file.ts ##
			 @@ src/file.ts
			-const first = old;
			+const first = new;
			 const mid1 = 1;
			 const mid2 = 2;
			 const mid3 = 3;
			...
			 const mid8 = 8;
			 const mid9 = 9;
			 const mid10 = 10;
			-const second = old;
			+const second = new;"
		`);
  });
});
