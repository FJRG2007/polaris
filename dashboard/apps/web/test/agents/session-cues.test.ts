import { describe, expect, it } from "vitest";
import { REPO_CUES_MAX, repoCuesSchema, withCues } from "@/lib/agents/session-cues";

describe("withCues", () => {
    it("leaves a prompt alone when the repository has none", () => {
        expect(withCues("", "Fix the login bug")).toBe("Fix the login bug");
        expect(withCues("   \n ", "Fix the login bug")).toBe("Fix the login bug");
        expect(withCues(null, "Fix the login bug")).toBe("Fix the login bug");
    });

    it("puts the cues ahead of the prompt, the prompt intact", () => {
        const sent = withCues("  Run the tests first.\n", "Fix the login bug");
        expect(sent.startsWith("Standing instructions for this repository")).toBe(true);
        expect(sent).toContain("Run the tests first.");
        expect(sent.endsWith("\n---\n\nFix the login bug")).toBe(true);
        expect(sent.indexOf("Run the tests first.")).toBeLessThan(sent.indexOf("Fix the login bug"));
    });
});

describe("repoCuesSchema", () => {
    it("trims what the form sends", () => {
        expect(repoCuesSchema.parse("  Lint first.  ")).toBe("Lint first.");
    });

    it("refuses more than a page", () => {
        expect(repoCuesSchema.safeParse("a".repeat(REPO_CUES_MAX + 1)).success).toBe(false);
        expect(repoCuesSchema.safeParse(` ${"a".repeat(REPO_CUES_MAX)} `).success).toBe(true);
    });
});
