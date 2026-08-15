/**
 * Whether a line is a code fence.
 *
 * The composer decides this on a keystroke: Enter on a fence opens a code block
 * instead of sending the message, which is the difference between being able to
 * paste code into a chat and not. It is a pure function precisely so the
 * decision can be pinned down without a browser.
 *
 * The empty-string answer is the one worth being careful about: a bare fence is
 * a code block with no language, which is a real answer and not the same as
 * "this is not a fence".
 */

import { describe, expect, it } from "vitest";
import { fenceLanguage } from "@/components/rich-text/markdown";

describe("recognising a code fence", () => {
    it("reads the language off a fence that names one", () => {
        expect(fenceLanguage("```py")).toBe("py");
        expect(fenceLanguage("```python")).toBe("python");
        expect(fenceLanguage("```ts")).toBe("ts");
    });

    it("accepts the languages whose names are not just letters", () => {
        expect(fenceLanguage("```c++")).toBe("c++");
        expect(fenceLanguage("```objective-c")).toBe("objective-c");
        expect(fenceLanguage("```c#")).toBe("c#");
    });

    it("calls a bare fence a fence with no language", () => {
        expect(fenceLanguage("```")).toBe("");
        expect(fenceLanguage("~~~")).toBe("");
    });

    it("tolerates the space somebody leaves either side", () => {
        expect(fenceLanguage("  ```py  ")).toBe("py");
    });

    it("is not fooled by a line that only starts with one", () => {
        // Inline code, and a sentence about fences. Neither opens a block.
        expect(fenceLanguage("```py print()")).toBeNull();
        expect(fenceLanguage("use ``` to open a block")).toBeNull();
        expect(fenceLanguage("``")).toBeNull();
        expect(fenceLanguage("")).toBeNull();
    });
});
