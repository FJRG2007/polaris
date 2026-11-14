/**
 * The name a downloaded code block is saved under. The extension is what makes
 * the file open in the right program, so a "python" fence must not become
 * `code.python`, and an unknown one must still be a file the reader can open.
 */

import { describe, expect, it } from "vitest";
import { fileNameForFence } from "@/lib/code-language";

describe("fileNameForFence", () => {
    it("uses the extension of the language, not its name", () => {
        expect(fileNameForFence("python")).toBe("code.py");
        expect(fileNameForFence("javascript")).toBe("code.js");
        expect(fileNameForFence("typescript")).toBe("code.ts");
        expect(fileNameForFence("bash")).toBe("code.sh");
    });

    it("keeps a fence tag that already is an extension", () => {
        expect(fileNameForFence("tsx")).toBe("code.tsx");
        expect(fileNameForFence("html")).toBe("code.html");
        expect(fileNameForFence(" PY ")).toBe("code.py");
    });

    it("names the files that have a name instead of an extension", () => {
        expect(fileNameForFence("dockerfile")).toBe("Dockerfile");
        expect(fileNameForFence("makefile")).toBe("Makefile");
    });

    it("falls back to plain text for an unknown or missing language", () => {
        expect(fileNameForFence(null)).toBe("code.txt");
        expect(fileNameForFence("")).toBe("code.txt");
        expect(fileNameForFence("wolfram")).toBe("code.txt");
        expect(fileNameForFence("../../etc")).toBe("code.txt");
    });

    it("never puts a symbol from the tag in the name", () => {
        expect(fileNameForFence("c++")).toBe("code.cpp");
        expect(fileNameForFence("csharp")).toBe("code.cs");
    });
});
