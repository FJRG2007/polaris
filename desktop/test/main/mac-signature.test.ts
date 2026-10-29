/**
 * Reading the team from `codesign --display --verbose=2`: Squirrel.Mac is used
 * only for an app signed with a Developer ID.
 */

import { describe, expect, it } from "vitest";
import { teamIdentifier } from "@/main/mac-signature";

describe("teamIdentifier", () => {
    it("reads the team of a Developer ID signature", () => {
        const output = ["Executable=/Applications/Polaris.app/Contents/MacOS/Polaris", "Authority=Developer ID Application: Example (AB12CD34EF)", "TeamIdentifier=AB12CD34EF", ""].join("\n");
        expect(teamIdentifier(output)).toBe("AB12CD34EF");
    });

    it("finds none in an ad-hoc signature or in no output", () => {
        expect(teamIdentifier("Signature=adhoc\nTeamIdentifier=not set\n")).toBeNull();
        expect(teamIdentifier("")).toBeNull();
    });
});
