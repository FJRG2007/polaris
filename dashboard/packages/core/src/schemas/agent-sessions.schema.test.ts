/**
 * The rules a session start has to satisfy once `repoId` may be null.
 *
 * A workspace is a session with nothing checked out, and the three refinements
 * below are what keep that shape honest: a branch or a task without a
 * repository is a form filled in wrong rather than a value quietly dropped, and
 * the shared machine is only ever an option on `local`, never on somebody's own
 * enrolled server.
 */

import { describe, expect, it } from "vitest";
import { startAgentSessionSchema } from "./agent-sessions.js";

function base(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        repoId: "018f2a3b-4c5d-7e8f-9012-3456789abcde",
        title: "Fix the login redirect",
        cli: "claude",
        ...overrides
    };
}

describe("startAgentSessionSchema, on the shape with no repository", () => {
    it("accepts a workspace: no repository, no branch, no task", () => {
        const parsed = startAgentSessionSchema.safeParse(base({ repoId: null }));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.repoId).toBeNull();
    });

    it("still defaults repoId to null when it is left out entirely", () => {
        const { repoId: _repoId, ...rest } = base();
        const parsed = startAgentSessionSchema.safeParse(rest);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.repoId).toBeNull();
    });

    it("refuses a branch on a workspace, since there is no checkout to have one", () => {
        const parsed = startAgentSessionSchema.safeParse(base({ repoId: null, baseRef: "main" }));
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["baseRef"]);
    });

    it("refuses a task on a workspace, since there is no repository for it to be in", () => {
        const parsed = startAgentSessionSchema.safeParse(
            base({ repoId: null, taskId: "018f2a3b-4c5d-7e8f-9012-3456789abcde" })
        );
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["repoId"]);
    });

    it("takes a branch and a task fine once there is a repository", () => {
        expect(
            startAgentSessionSchema.safeParse(
                base({ baseRef: "main", taskId: "018f2a3b-4c5d-7e8f-9012-3456789abcde" })
            ).success
        ).toBe(true);
    });
});

describe("startAgentSessionSchema, on the machine everybody shares", () => {
    it("defaults sharedHome to false", () => {
        const parsed = startAgentSessionSchema.safeParse(base({ repoId: null }));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.sharedHome).toBe(false);
    });

    it("takes it on the box Polaris runs", () => {
        expect(
            startAgentSessionSchema.safeParse(
                base({ repoId: null, place: "local", sharedHome: true })
            ).success
        ).toBe(true);
    });

    it("refuses it on an enrolled server, which already has a home of its own", () => {
        const parsed = startAgentSessionSchema.safeParse(
            base({
                repoId: null,
                place: "host",
                hostId: "018f2a3b-4c5d-7e8f-9012-3456789abcde",
                sharedHome: true
            })
        );
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["sharedHome"]);
    });
});

describe("signing in with the machine's own login", () => {
    it("is off unless somebody asks for it", () => {
        const parsed = startAgentSessionSchema.safeParse(base({}));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.useMachineLogin).toBe(false);
    });

    it("is a third answer, not a shade of 'whichever resolves'", () => {
        // Null accountId means "whichever of mine resolves". This means none of
        // them: the machine is signed in already and a stored token injected
        // over that is how a credential revoked months ago beats a login that
        // works - the tool reads the variable first and never looks at the home.
        const parsed = startAgentSessionSchema.safeParse(
            base({ useMachineLogin: true, accountId: null })
        );
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.useMachineLogin).toBe(true);
            expect(parsed.data.accountId).toBeNull();
        }
    });

    it("refuses a form that asks for both", () => {
        // Two different answers to one question. Accepting both would leave the
        // server to pick, and whichever it picked would be wrong for somebody.
        const parsed = startAgentSessionSchema.safeParse(
            base({
                useMachineLogin: true,
                accountId: "018f2a3b-4c5d-7e8f-9012-3456789abcde"
            })
        );
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["accountId"]);
    });
});
