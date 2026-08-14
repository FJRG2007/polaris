/**
 * A service's history, in the words somebody reads after it stops working.
 *
 * The one that matters is the variable: the feed says which variable changed and
 * must never say what it changed to, because a service's activity is readable by
 * anybody who can open the service and a value is often a credential.
 */

import { describe, expect, it } from "vitest";
import type { ActivityLine } from "../../src/lib/activity/activity";
import { describeServiceEvent } from "../../src/app/(app)/apps/deploy/service-history";

function line(overrides: Partial<ActivityLine> = {}): ActivityLine {
    return {
        id: "l1",
        action: "deployed",
        fromValue: null,
        toValue: null,
        authorName: "Ana",
        createdAt: "2026-08-15T10:00:00.000Z",
        ...overrides
    };
}

describe("describing what happened to a service", () => {
    it("names whoever did it", () => {
        expect(describeServiceEvent(line())).toBe("Ana deployed it");
        expect(describeServiceEvent(line({ action: "restarted" }))).toBe("Ana restarted it");
    });

    it("credits Polaris when nobody is named", () => {
        expect(describeServiceEvent(line({ authorName: null }))).toBe("Polaris deployed it");
    });

    it("names the variable and never its value", () => {
        const sentence = describeServiceEvent(line({ action: "variable", toValue: "DATABASE_URL" }));

        expect(sentence).toBe("Ana changed the DATABASE_URL variable");
        // The line carries a key, and there is nowhere in it for a value to be.
        expect(sentence).not.toContain("postgres");
    });

    it("still reads as a sentence when the variable's name was not recorded", () => {
        expect(describeServiceEvent(line({ action: "variable" }))).toBe("Ana changed a variable");
    });

    it("counts an import rather than listing it", () => {
        expect(describeServiceEvent(line({ action: "variables-imported", toValue: "12" }))).toBe(
            "Ana imported 12 variables"
        );
    });

    it("falls back to something true for an action it does not know", () => {
        expect(describeServiceEvent(line({ action: "something-new" }))).toBe("Ana changed it");
    });
});
