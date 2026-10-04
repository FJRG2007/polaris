import { describe, expect, it } from "vitest";
import { fresh } from "@polaris-app/game-servers/src/lib/fresh";

describe("whether something looked at is still fresh", () => {
    it("holds for less than its time, and not a moment longer", () => {
        expect(fresh(1_000, 500, 1_000)).toBe(true);
        expect(fresh(1_000, 500, 1_499)).toBe(true);
        expect(fresh(1_000, 500, 1_500)).toBe(false);
    });

    it("never holds when it was looked at after now: the clock went back", () => {
        // Kept by a clock days ahead, read by one set right: looked at again.
        const ahead = Date.parse("2026-10-04T02:00:00Z");
        const now = Date.parse("2026-09-28T20:00:00Z");
        expect(fresh(ahead, 10_000, now)).toBe(false);
        expect(fresh(1_001, 500, 1_000)).toBe(false);
    });
});
