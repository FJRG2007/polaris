/**
 * A session's pull request failing its checks, becoming ready or being merged
 * reaches the session's owner, linked to the session, once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    sessions: [] as Array<{
        id: string;
        title: string;
        prNumber: number | null;
        startedById: string | null;
        repo: { ownerId: string; repoFullName: string };
    }>,
    findManyArgs: [] as unknown[]
}));

const notify = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ inapp: "sent" })));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                db.sessions.find((row) => row.id === where.id) ?? null,
            findMany: async (args: {
                where: { prNumber: { in: number[] }; repo: { repoFullName: string } };
                take: number;
            }) => {
                db.findManyArgs.push(args);
                return db.sessions
                    .filter(
                        (row) =>
                            row.prNumber !== null &&
                            args.where.prNumber.in.includes(row.prNumber) &&
                            row.repo.repoFullName === args.where.repo.repoFullName
                    )
                    .slice(0, args.take);
            }
        }
    }
}));

vi.mock("@/lib/notifications/dispatch", () => ({ notify, pushNotice: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, values?: Record<string, unknown>) =>
        `${key}${values ? JSON.stringify(values) : ""}`
}));

import { notificationEvent, resolveRule } from "@polaris/core";
import { pullNoticeOf, noticePullEvent } from "@/lib/agents/session-pull-notices";

const REPO = { full_name: "acme/app" };

beforeEach(() => {
    notify.mockClear();
    db.findManyArgs = [];
    db.sessions = [
        {
            id: "s-1",
            title: "Fix login",
            prNumber: 7,
            startedById: "owner-1",
            repo: { ownerId: "repo-owner", repoFullName: "acme/app" }
        },
        {
            id: "s-2",
            title: "Other",
            prNumber: 8,
            startedById: null,
            repo: { ownerId: "repo-owner", repoFullName: "acme/app" }
        }
    ];
});

describe("pullNoticeOf", () => {
    it("reads a merge", () => {
        expect(
            pullNoticeOf("pull_request", {
                action: "closed",
                repository: REPO,
                pull_request: { number: 7, merged: true }
            })
        ).toEqual({ repoFullName: "acme/app", kind: "pr_merged", prNumbers: [7], headSha: null });
    });

    it("ignores a pull request closed without merging", () => {
        expect(
            pullNoticeOf("pull_request", {
                action: "closed",
                repository: REPO,
                pull_request: { number: 7, merged: false }
            })
        ).toBeNull();
    });

    it("reads ready for review and a non-draft opening, not a draft", () => {
        const of = (action: string, draft: boolean) =>
            pullNoticeOf("pull_request", {
                action,
                repository: REPO,
                pull_request: { number: 7, draft }
            })?.kind ?? null;
        expect(of("ready_for_review", false)).toBe("pr_ready");
        expect(of("opened", false)).toBe("pr_ready");
        expect(of("opened", true)).toBeNull();
        expect(of("synchronize", false)).toBeNull();
    });

    it("reads a failed check suite with its pull requests and commit", () => {
        expect(
            pullNoticeOf("check_suite", {
                action: "completed",
                repository: REPO,
                check_suite: {
                    conclusion: "failure",
                    head_sha: "abc123",
                    pull_requests: [{ number: 7 }, { number: 7 }, { number: 8 }]
                }
            })
        ).toEqual({
            repoFullName: "acme/app",
            kind: "ci_failed",
            prNumbers: [7, 8],
            headSha: "abc123"
        });
    });

    it("ignores a passing suite, one with no pull request, and malformed payloads", () => {
        const suite = (conclusion: string, pulls: unknown[]) =>
            pullNoticeOf("check_suite", {
                action: "completed",
                repository: REPO,
                check_suite: { conclusion, pull_requests: pulls }
            });
        expect(suite("success", [{ number: 7 }])).toBeNull();
        expect(suite("failure", [])).toBeNull();
        expect(pullNoticeOf("check_suite", { action: "completed" })).toBeNull();
        expect(pullNoticeOf("pull_request", "nonsense")).toBeNull();
        expect(pullNoticeOf("push", { repository: REPO })).toBeNull();
    });
});

describe("noticePullEvent", () => {
    it("tells the person who started the session, linked to it", async () => {
        await noticePullEvent("pull_request", {
            action: "closed",
            repository: REPO,
            pull_request: { number: 7, merged: true }
        });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "owner-1",
                event: "agent.pr.merged",
                href: "/polar?session=s-1",
                level: "success",
                dedupKey: "agent.pr.merged:s-1:7",
                push: { tag: "agent-session:s-1" }
            })
        );
    });

    it("falls back to the repository's owner and keys failures by commit", async () => {
        await noticePullEvent("check_suite", {
            action: "completed",
            repository: REPO,
            check_suite: { conclusion: "failure", head_sha: "abc", pull_requests: [{ number: 8 }] }
        });
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "repo-owner",
                event: "agent.ci.failed",
                dedupKey: "agent.ci.failed:s-2:abc"
            })
        );
    });

    it("reads a bounded number of sessions and none for another repository", async () => {
        await noticePullEvent("pull_request", {
            action: "ready_for_review",
            repository: { full_name: "acme/other" },
            pull_request: { number: 7 }
        });
        expect(notify).not.toHaveBeenCalled();
        expect((db.findManyArgs[0] as { take: number }).take).toBeLessThanOrEqual(10);
    });
});

describe("catalogue", () => {
    it("declares every kind, on the bell by default and switchable", () => {
        for (const id of ["agent.approval", "agent.ci.failed", "agent.pr.ready", "agent.pr.merged"]) {
            const event = notificationEvent(id);
            expect(event?.group).toBe("agents");
            expect(event?.critical).not.toBe(true);
            expect(resolveRule({}, id).inapp).toBe(true);
        }
    });
});
