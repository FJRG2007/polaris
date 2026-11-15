/**
 * A session's pull request, as GitHub's webhook tells it: checks failed, ready
 * for review, merged. Each becomes a notice to the session's owner through
 * `noticeSessionPull`, which links to the session.
 *
 * Read before the webhook ignores its own App's events, on purpose: a pull
 * request a session opened was opened by that App, and is exactly the one this
 * is about. Nothing here starts a run; it only finds the sessions that opened
 * the pull requests named and tells their owners.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { noticeSessionPull, type PullNoticeKind } from "./agent-notices";

/** The most sessions one delivery can notify. A check suite names a handful of
 *  pull requests at most; this is a ceiling on what a payload can make us read. */
const MAX_SESSIONS = 10;

const prNumber = z.number().int().positive();

const pullRequestEvent = z.object({
    action: z.string(),
    repository: z.object({ full_name: z.string().min(1).max(256) }),
    pull_request: z.object({
        number: prNumber,
        draft: z.boolean().optional(),
        merged: z.boolean().optional()
    })
});

const checkSuiteEvent = z.object({
    action: z.string(),
    repository: z.object({ full_name: z.string().min(1).max(256) }),
    check_suite: z.object({
        conclusion: z.string().nullish(),
        head_sha: z.string().max(64).nullish(),
        pull_requests: z
            .array(z.object({ number: prNumber }).passthrough())
            .max(MAX_SESSIONS)
            .optional()
    })
});

export interface PullNotice {
    repoFullName: string;
    kind: PullNoticeKind;
    prNumbers: number[];
    headSha: string | null;
}

/** What a delivery says about pull requests, or null when it says nothing a
 *  session's owner is told about. Pure, so the mapping can be asserted. */
export function pullNoticeOf(event: string, payload: unknown): PullNotice | null {
    if (event === "pull_request") {
        const parsed = pullRequestEvent.safeParse(payload);
        if (!parsed.success) return null;
        const { action, repository, pull_request: pull } = parsed.data;
        const kind: PullNoticeKind | null =
            action === "closed" && pull.merged === true
                ? "pr_merged"
                : action === "ready_for_review" ||
                    ((action === "opened" || action === "reopened") && pull.draft !== true)
                  ? "pr_ready"
                  : null;
        if (!kind) return null;
        return { repoFullName: repository.full_name, kind, prNumbers: [pull.number], headSha: null };
    }
    if (event === "check_suite") {
        const parsed = checkSuiteEvent.safeParse(payload);
        if (!parsed.success) return null;
        const { action, repository, check_suite: suite } = parsed.data;
        if (action !== "completed" || suite.conclusion !== "failure") return null;
        const prNumbers = [...new Set((suite.pull_requests ?? []).map((pull) => pull.number))];
        if (prNumbers.length === 0) return null;
        return {
            repoFullName: repository.full_name,
            kind: "ci_failed",
            prNumbers,
            headSha: suite.head_sha ?? null
        };
    }
    return null;
}

/** Tell the owner of every session behind the pull requests a delivery names.
 *  Never throws: it rides along on the webhook and must not fail it. */
export async function noticePullEvent(event: string, payload: unknown): Promise<void> {
    const notice = pullNoticeOf(event, payload);
    if (!notice) return;
    try {
        const sessions = await prisma.agentSession.findMany({
            where: {
                prNumber: { in: notice.prNumbers },
                repo: { repoFullName: notice.repoFullName }
            },
            select: { id: true, prNumber: true },
            orderBy: { createdAt: "desc" },
            take: MAX_SESSIONS
        });
        await Promise.all(
            sessions.map((session) =>
                session.prNumber === null
                    ? undefined
                    : noticeSessionPull(session.id, notice.kind, {
                          prNumber: session.prNumber,
                          headSha: notice.headSha
                      })
            )
        );
    } catch (error) {
        console.error("polaris: could not raise pull request notices:", error);
    }
}
