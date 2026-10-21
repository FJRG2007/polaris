/**
 * Shipping a session: one pull request per branch, opened or found, and only for
 * whoever may steer the session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    allowed: true,
    session: null as Record<string, unknown> | null,
    listCalls: 0,
    shipCalls: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
        agentSessionMessage: { findFirst: vi.fn(async () => null) }
    }
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallationToken: vi.fn(async () => "token"),
    pullRequestsForBranch: vi.fn(),
    repoDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
    readPullRequest: vi.fn()
}));
// What the GitHub App reach check imports; the real one reaches the OAuth adapters.
vi.mock("@/lib/github-access", () => ({
    credentialFor: vi.fn(),
    githubCredentialsForUser: vi.fn(async () => [])
}));
vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn() }));
vi.mock("@/lib/agents/session-work", () => ({ saveSessionWork: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({}));
vi.mock("@/lib/tasks/task-detail-service", () => ({ addComment: vi.fn() }));
vi.mock("@/lib/agents/agent-readiness", () => ({
    agentChoicesFor: vi.fn(),
    agentOptionsFor: vi.fn()
}));
vi.mock("@/lib/agents/session-capacity", () => ({
    capacityRefusal: vi.fn(),
    sessionCapacity: vi.fn(),
    sharedWorkspaceAllowed: vi.fn(),
    workspaceHolders: vi.fn(),
    workspaceRefusal: vi.fn()
}));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/agents/words", () => ({
    agentText: (_t: unknown, text: string) => text,
    knownAgentText: vi.fn()
}));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: vi.fn(async () => "https://polaris.example.test/")
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async (permission: string) => {
        if (permission === "agents.manage" && !state.allowed) throw new Error("forbidden");
        return { id: "user-1" };
    })
}));
vi.mock("@/lib/agents/session-service", () => ({
    getSession: vi.fn(async () => state.session)
}));

import * as github from "@/lib/github-service";
import { runInSession } from "@/lib/agents/session-runtime";
import { saveSessionWork } from "@/lib/agents/session-work";
import * as review from "@/lib/agents/session-review";
import {
    openSessionPullRequestAction,
    sessionChangesAction,
    sessionFileDiffAction
} from "@/app/(app)/apps/agents/sessions/actions";

const SESSION_ID = "0190a0f0-0000-7000-8000-000000000001";

const session = {
    id: SESSION_ID,
    repoFullName: "acme/app",
    branch: "polaris/fix-login",
    baseRef: "main",
    place: "local" as const,
    state: "working" as const,
    work: null
};

const pull = (number: number, state: github.PullRequestState): github.BranchPullRequest => ({
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: "t",
    state,
    draft: false
});

function deps(overrides: Partial<review.ShipDeps> = {}) {
    const recorded: number[] = [];
    const created: { head: string; base: string }[] = [];
    const value: review.ShipDeps = {
        token: async () => "token",
        push: async () => ({ kind: "pushed", commits: 2, branch: session.branch }),
        pullsForBranch: async () => [],
        defaultBranch: async () => "trunk",
        create: async (_owner, _repo, input) => {
            created.push({ head: input.head, base: input.base });
            return { ok: true, pull: pull(7, "open") };
        },
        record: async (_id, pr) => {
            recorded.push(pr.number);
        },
        ...overrides
    };
    return { value, recorded, created };
}

const draft = { title: "Fix login", body: "body" };

describe("opening a session's pull request", () => {
    it("pushes, then opens one against the session's base and links it", async () => {
        const { value, recorded, created } = deps();
        const result = await review.openSessionPullRequest(session, "restricted", draft, value);
        expect(result).toEqual({ kind: "opened", pull: pull(7, "open") });
        expect(created).toEqual([{ head: "polaris/fix-login", base: "main" }]);
        expect(recorded).toEqual([7]);
    });

    it("shows the branch's open pull request instead of opening a second", async () => {
        const create = vi.fn();
        const { value, recorded } = deps({
            pullsForBranch: async () => [pull(3, "closed"), pull(5, "open")],
            create
        });
        const result = await review.openSessionPullRequest(session, "enabled", draft, value);
        expect(result).toEqual({ kind: "existing", pull: pull(5, "open") });
        expect(create).not.toHaveBeenCalled();
        expect(recorded).toEqual([5]);
    });

    it("opens a new one when the only one was closed without merging", async () => {
        const { value, created } = deps({ pullsForBranch: async () => [pull(3, "closed")] });
        expect((await review.openSessionPullRequest(session, "enabled", draft, value)).kind).toBe(
            "opened"
        );
        expect(created).toHaveLength(1);
    });

    it("opens a new one for work that came after the branch's merged one", async () => {
        const { value, created, recorded } = deps({
            pullsForBranch: async () => [pull(4, "merged")]
        });
        expect(await review.openSessionPullRequest(session, "enabled", draft, value)).toEqual({
            kind: "opened",
            pull: pull(7, "open")
        });
        expect(created).toHaveLength(1);
        expect(recorded).toEqual([7]);
    });

    it("links the merged one when nothing came after it", async () => {
        const { value, recorded } = deps({
            pullsForBranch: async () => [pull(4, "merged")],
            create: async () => ({ ok: false, reason: "noChanges" })
        });
        expect(await review.openSessionPullRequest(session, "enabled", draft, value)).toEqual({
            kind: "existing",
            pull: pull(4, "merged")
        });
        expect(recorded).toEqual([4]);
    });

    it("links the one GitHub says already exists when it raced in between", async () => {
        let asked = 0;
        const { value, recorded } = deps({
            pullsForBranch: async () => (asked++ === 0 ? [] : [pull(9, "open")]),
            create: async () => ({ ok: false, reason: "exists" })
        });
        expect(await review.openSessionPullRequest(session, "enabled", draft, value)).toEqual({
            kind: "existing",
            pull: pull(9, "open")
        });
        expect(recorded).toEqual([9]);
    });

    it("uses the repository's default branch when the session recorded no base", async () => {
        const { value, created } = deps();
        await review.openSessionPullRequest({ ...session, baseRef: "" }, "enabled", draft, value);
        expect(created[0]?.base).toBe("trunk");
    });

    it("refuses a read-only repository and a workspace before touching anything", async () => {
        const push = vi.fn();
        const { value } = deps({ push });
        expect(await review.openSessionPullRequest(session, "disabled", draft, value)).toEqual({
            kind: "refused",
            reason: "readOnly"
        });
        expect(
            await review.openSessionPullRequest(
                { ...session, repoFullName: "" },
                "enabled",
                draft,
                value
            )
        ).toEqual({
            kind: "refused",
            reason: "workspace"
        });
        expect(push).not.toHaveBeenCalled();
    });

    it("stops when there is no installation token, or the push was kept", async () => {
        expect(
            await review.openSessionPullRequest(
                session,
                "enabled",
                draft,
                deps({ token: async () => null }).value
            )
        ).toEqual({ kind: "refused", reason: "noAuth" });
        const kept = deps({
            push: async () => ({
                kind: "kept",
                commits: 1,
                branch: session.branch,
                reason: "rejected"
            })
        });
        expect(await review.openSessionPullRequest(session, "enabled", draft, kept.value)).toEqual({
            kind: "refused",
            reason: "push",
            pushReason: "rejected"
        });
        const policy = deps({
            push: async () => ({
                kind: "kept",
                commits: 1,
                branch: session.branch,
                reason: "policy"
            })
        });
        expect(
            await review.openSessionPullRequest(session, "enabled", draft, policy.value)
        ).toEqual({
            kind: "refused",
            reason: "readOnly"
        });
    });

    it("says there is nothing to propose when GitHub finds no commits", async () => {
        const { value } = deps({ create: async () => ({ ok: false, reason: "noChanges" }) });
        expect(await review.openSessionPullRequest(session, "enabled", draft, value)).toEqual({
            kind: "refused",
            reason: "noChanges"
        });
    });
});

describe("the draft", () => {
    it("quotes the first prompt and links the session", () => {
        const result = review.pullRequestDraft({
            title: "  Fix   the login  ",
            prompt: "Make it work\nwith SSO",
            sessionUrl: "https://polaris.example.test/apps/agents/sessions/x",
            words: {
                fallbackTitle: "Fallback",
                asked: "Asked:",
                openedFrom: (url) => `From ${url}`
            }
        });
        expect(result.title).toBe("Fix the login");
        expect(result.body).toBe(
            "Asked:\n\n> Make it work\n> with SSO\n\nFrom https://polaris.example.test/apps/agents/sessions/x"
        );
        expect(
            review.pullRequestDraft({
                title: " ",
                prompt: null,
                sessionUrl: "u",
                words: { fallbackTitle: "Fallback", asked: "Asked:", openedFrom: (url) => url }
            })
        ).toEqual({ title: "Fallback", body: "u" });
    });
});

describe("who may use it", () => {
    beforeEach(() => {
        state.allowed = true;
        state.session = { ...session, pullRequest: null };
    });

    it("refuses an account without agents.manage, and never reaches the machine", async () => {
        state.allowed = false;
        await expect(sessionChangesAction({ sessionId: SESSION_ID })).rejects.toThrow("forbidden");
        await expect(
            sessionFileDiffAction({ sessionId: SESSION_ID, path: "a.ts" })
        ).rejects.toThrow("forbidden");
        await expect(
            openSessionPullRequestAction({ sessionId: SESSION_ID, title: "x", body: "" })
        ).rejects.toThrow("forbidden");
        expect(runInSession).not.toHaveBeenCalled();
        expect(saveSessionWork).not.toHaveBeenCalled();
    });

    it("answers a session this account does not reach as gone", async () => {
        state.session = null;
        expect(
            await openSessionPullRequestAction({ sessionId: SESSION_ID, title: "x", body: "" })
        ).toEqual({
            error: "sessions.errors.gone"
        });
        expect(await sessionChangesAction({ sessionId: SESSION_ID })).toEqual({
            error: "sessions.errors.gone"
        });
        expect(runInSession).not.toHaveBeenCalled();
        expect(saveSessionWork).not.toHaveBeenCalled();
    });

    it("validates input before anything else", async () => {
        expect(
            await sessionFileDiffAction({ sessionId: SESSION_ID, path: "../../etc/passwd" })
        ).toEqual({
            error: "session.changes.errors.invalid"
        });
        expect(await sessionChangesAction({ sessionId: "not-a-uuid" })).toEqual({
            error: "session.changes.errors.invalid"
        });
        expect(
            await openSessionPullRequestAction({ sessionId: SESSION_ID, title: "   ", body: "" })
        ).toEqual({
            error: "session.ship.errors.invalid"
        });
    });
});
