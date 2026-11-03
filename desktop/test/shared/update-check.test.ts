/**
 * "Check for updates" answers in words, and a malformed answer reads as a failure.
 */

import { describe, expect, it } from "vitest";
import { describeUpdateCheck, readUpdateCheck } from "@/shared/update-check";

describe("update check", () => {
    it("says each outcome in words", () => {
        expect(describeUpdateCheck({ kind: "current", version: "0.1.13" })).toBe("Polaris 0.1.13 is the newest version.");
        expect(describeUpdateCheck({ kind: "downloading", version: "0.1.14" })).toContain("Downloading Polaris 0.1.14");
        expect(describeUpdateCheck({ kind: "ready", version: "0.1.14" })).toContain("Restart Polaris");
        expect(describeUpdateCheck({ kind: "available", version: "0.1.14" })).toContain("download it from its page");
        expect(describeUpdateCheck({ kind: "failed", reason: "github.com did not answer in time." })).toBe(
            "Could not check for updates. github.com did not answer in time."
        );
        expect(describeUpdateCheck({ kind: "unsupported" })).toBe("This copy of Polaris does not update itself.");
    });

    it("reads a malformed answer as a failure", () => {
        expect(readUpdateCheck({ kind: "current", version: "0.1.13" })).toEqual({ kind: "current", version: "0.1.13" });
        expect(readUpdateCheck(null).kind).toBe("failed");
        expect(readUpdateCheck({ kind: "ready" }).kind).toBe("failed");
    });
});
