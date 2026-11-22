import { describe, expect, it } from "vitest";
import { nameInUse } from "@/lib/polar/custom-tools/shared";

/** The tool form says a name is taken while it is typed, the way the server compares it. */
describe("nameInUse", () => {
    const tools = [
        { id: "a", name: "run_tests" },
        { id: "b", name: "deploy" }
    ];

    it("finds another tool's name, trimmed and in any case", () => {
        expect(nameInUse("run_tests", tools, null)).toBe(true);
        expect(nameInUse("  Run_Tests ", tools, null)).toBe(true);
    });

    it("lets a tool keep its own name while it is edited", () => {
        expect(nameInUse("run_tests", tools, "a")).toBe(false);
        expect(nameInUse("deploy", tools, "a")).toBe(true);
    });

    it("says nothing for an empty field or a free name", () => {
        expect(nameInUse("", tools, null)).toBe(false);
        expect(nameInUse("   ", tools, null)).toBe(false);
        expect(nameInUse("lint", tools, null)).toBe(false);
    });
});
