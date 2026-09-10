/**
 * A service's history, in the words somebody reads after it stops working.
 *
 * The one that matters is the variable: the feed says which variable changed and
 * must never say what it changed to, because a service's activity is readable by
 * anybody who can open the service and a value is often a credential.
 */

import { describe, expect, it } from "vitest";
import type { ActivityLine } from "../../src/lib/activity/activity";
import { describeServiceEvent, unresolvedSetupFailure } from "../../src/app/(app)/apps/deploy/service-history";

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

describe("a one-click service's setup", () => {
    const polaris = { authorName: null };

    it("says which step ran and what it printed", () => {
        expect(
            describeServiceEvent(line({ ...polaris, action: "setup", fromValue: "Create the first bucket", toValue: "uploads" }))
        ).toBe('Polaris ran "Create the first bucket": uploads');
        expect(describeServiceEvent(line({ ...polaris, action: "setup", fromValue: "Install FreshRSS" }))).toBe(
            'Polaris ran "Install FreshRSS"'
        );
    });

    it("says which step failed and why", () => {
        const failed = line({
            ...polaris,
            action: "setup-failed",
            fromValue: "Create the Gitea admin",
            toValue: "It was not ready after 40 checks 3 seconds apart."
        });
        expect(describeServiceEvent(failed)).toBe(
            'Polaris could not run "Create the Gitea admin": It was not ready after 40 checks 3 seconds apart.'
        );
    });

    it("says what kept it from being deployed", () => {
        const blocked = line({
            ...polaris,
            action: "setup-blocked",
            fromValue: "its database blog-db",
            toValue: "the deploy failed"
        });
        expect(describeServiceEvent(blocked)).toBe(
            "Polaris did not deploy it, because its database blog-db did not come up: the deploy failed"
        );
    });
});

describe("unresolvedSetupFailure", () => {
    // Newest first, the order the history is read in.
    const failed = line({ id: "f", action: "setup-failed", fromValue: "Install FreshRSS", toValue: "It exited with code 1." });
    const blocked = line({ id: "b", action: "setup-blocked", fromValue: "its database blog-db", toValue: "no" });

    it("is the newest setup line when that one failed", () => {
        expect(unresolvedSetupFailure([line({ action: "variable" }), failed])).toBe(failed);
    });

    it("is over once a later run of the setup went through", () => {
        expect(unresolvedSetupFailure([line({ action: "setup", fromValue: "Install FreshRSS" }), failed])).toBeNull();
    });

    it("stays for a failed setup command after a redeploy, which does not run it", () => {
        expect(unresolvedSetupFailure([line({ action: "deployed" }), failed])).toBe(failed);
    });

    it("is over for a deploy that never started once somebody deploys the service", () => {
        expect(unresolvedSetupFailure([blocked])).toBe(blocked);
        expect(unresolvedSetupFailure([line({ action: "deployed" }), blocked])).toBeNull();
    });

    it("is nothing for a service with no setup at all", () => {
        expect(unresolvedSetupFailure([line(), line({ action: "restarted" })])).toBeNull();
    });
});
