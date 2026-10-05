import { describe, expect, it } from "vitest";
import { handleToolSuccess } from "./shared.ts";

// Tool results reach the model as TOON (@toon-format/toon). These pin the encoding
// the prompts are written against, so a library upgrade that changes it shows up
// here instead of as an agent quietly misreading its own tool output.
describe("handleToolSuccess", () => {
  const text = (data: Parameters<typeof handleToolSuccess>[0]) => handleToolSuccess(data).content[0]?.text;

  it("passes a string through untouched", () => {
    expect(text("done")).toBe("done");
  });

  it("encodes scalars as key: value lines and uniform rows as a table", () => {
    expect(
      text({
        repo: "o/r",
        count: 3,
        ok: true,
        note: "line1\nline2",
        empty: [],
        items: [
          { id: 1, name: "a" },
          { id: 2, name: "b,c" },
        ],
      })
    ).toBe(
      ["repo: o/r", "count: 3", "ok: true", 'note: "line1\\nline2"', "empty: []", "items[2]{id,name}:", "  1,a", '  2,"b,c"'].join("\n")
    );
  });

  it("encodes a __proto__ key from untrusted JSON as data, without touching Object.prototype", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}') as Record<string, unknown>;
    expect(text(payload)).toBe("__proto__:\n  polluted: 1\na: 1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("is never an error result", () => {
    expect(handleToolSuccess({ a: 1 }).isError).toBeUndefined();
  });
});
