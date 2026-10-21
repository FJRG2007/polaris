/**
 * Telling somebody that an agent needs them, finished, or ended.
 *
 * Running an agent in the background is only worth it if nobody has to watch
 * it, so the moments that need a person - a question, a permission prompt, a run
 * that finished, a session that died or whose work could not be pushed - land
 * in the bell. Each notice links to the session or run it is about, and the
 * "needs you" one is answered rather than left standing: it is marked read the
 * moment the session moves on or its page is opened.
 *
 * Nothing here throws at its caller. A notice is a side effect, and a hook
 * report or a Stop must not fail because the bell did.
 */

import { prisma } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";

export const WAITING_EVENT = "agent.waiting";

/** The page a session's notices point at. */
export function sessionHref(sessionId: string): string {
    return `/apps/agents/sessions/${sessionId}`;
}

/** The page a run's notices point at. */
export function runHref(runId: string): string {
    return `/apps/agents/runs?run=${runId}`;
}

interface SessionSubject {
    id: string;
    title: string;
    ownerId: string | null;
}

async function sessionSubject(sessionId: string): Promise<SessionSubject | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: {
            id: true,
            title: true,
            startedById: true,
            repo: { select: { ownerId: true } }
        }
    });
    if (!row) return null;
    // The person who started it first: a repository's owner may be an account
    // that never opened this session, and the one waiting is whoever did.
    const ownerId = row.startedById ?? row.repo?.ownerId ?? null;
    return { id: row.id, title: row.title, ownerId };
}

function quietly(what: string, error: unknown): void {
    console.error(`polaris: could not raise the agent notice for ${what}:`, error);
}

/**
 * The session started waiting on its owner.
 *
 * Once per waiting episode: the claim on `waitingNotifiedAt` is what makes a
 * burst of permission prompts one notice, and it is a conditional write so two
 * hook reports arriving together cannot both win it.
 */
export async function noticeSessionWaiting(sessionId: string): Promise<void> {
    try {
        const claimed = await prisma.agentSession.updateMany({
            where: { id: sessionId, waitingNotifiedAt: null },
            data: { waitingNotifiedAt: new Date() }
        });
        if (claimed.count === 0) return;
        const subject = await sessionSubject(sessionId);
        if (!subject?.ownerId) return;
        const t = await wordsFor(subject.ownerId, "notices");
        await notify({
            userId: subject.ownerId,
            event: WAITING_EVENT,
            title: t("agents.waitingTitle", { session: subject.title }),
            body: t("agents.waitingBody"),
            href: sessionHref(subject.id),
            actionRequired: true,
            metadata: { sessionId: subject.id }
        });
    } catch (error) {
        quietly(`session ${sessionId} waiting`, error);
    }
}

/**
 * The session is no longer waiting, or its owner opened it: the episode is
 * over. The claim is released so the next question is a new notice, and the
 * one already in the bell is marked answered.
 */
export async function clearSessionWaiting(sessionId: string, userId?: string): Promise<void> {
    try {
        await prisma.agentSession.updateMany({
            where: { id: sessionId, waitingNotifiedAt: { not: null } },
            data: { waitingNotifiedAt: null }
        });
        await prisma.notification.updateMany({
            where: {
                type: WAITING_EVENT,
                href: sessionHref(sessionId),
                ...(userId ? { userId } : {}),
                OR: [{ readAt: null }, { actionRequired: true }]
            },
            data: { readAt: new Date(), actionRequired: false }
        });
    } catch (error) {
        quietly(`session ${sessionId} answered`, error);
    }
}

/**
 * Mark the "needs you" notice read because its page was opened, without ending
 * the episode: the session is still waiting, and opening it is not the same as
 * answering it, so another prompt in the same wait stays quiet.
 */
export async function readSessionWaiting(sessionId: string, userId: string): Promise<void> {
    try {
        await prisma.notification.updateMany({
            where: { type: WAITING_EVENT, href: sessionHref(sessionId), userId, readAt: null },
            data: { readAt: new Date() }
        });
    } catch (error) {
        quietly(`session ${sessionId} opened`, error);
    }
}

/** Why a session ended without anybody pressing Stop. */
export type EndedReason = "failed" | "silent" | "exited";

const ENDED_BODY = {
    failed: "agents.failedBody",
    silent: "agents.silentBody",
    exited: "agents.exitedBody"
} as const;

export async function noticeSessionEnded(sessionId: string, reason: EndedReason): Promise<void> {
    try {
        const subject = await sessionSubject(sessionId);
        if (!subject?.ownerId) return;
        const t = await wordsFor(subject.ownerId, "notices");
        await notify({
            userId: subject.ownerId,
            event: "agent.ended",
            title: t("agents.endedTitle", { session: subject.title }),
            body: t(ENDED_BODY[reason]),
            href: sessionHref(subject.id),
            level: reason === "exited" ? "info" : reason === "failed" ? "danger" : "warning",
            metadata: { sessionId: subject.id, reason }
        });
    } catch (error) {
        quietly(`session ${sessionId} ended`, error);
    }
}

/** The session ended with work Polaris could not push, so it kept the machine. */
export async function noticeWorkKept(sessionId: string, branch: string): Promise<void> {
    try {
        const subject = await sessionSubject(sessionId);
        if (!subject?.ownerId) return;
        const t = await wordsFor(subject.ownerId, "notices");
        await notify({
            userId: subject.ownerId,
            event: "agent.work",
            title: t("agents.workKeptTitle", { session: subject.title }),
            body: t("agents.workKeptBody", { branch }),
            href: sessionHref(subject.id),
            actionRequired: true,
            metadata: { sessionId: subject.id, branch }
        });
    } catch (error) {
        quietly(`session ${sessionId} work`, error);
    }
}

/** The kept work was pushed or discarded: nothing is waiting on anybody now. */
export async function clearWorkKept(sessionId: string): Promise<void> {
    try {
        await prisma.notification.updateMany({
            where: {
                type: "agent.work",
                href: sessionHref(sessionId),
                OR: [{ readAt: null }, { actionRequired: true }]
            },
            data: { readAt: new Date(), actionRequired: false }
        });
    } catch (error) {
        quietly(`session ${sessionId} work settled`, error);
    }
}

/** A background run finished. A cancelled one is not news: somebody pressed it. */
export async function noticeRunFinished(
    runId: string,
    state: "succeeded" | "failed"
): Promise<void> {
    try {
        const run = await prisma.agentRun.findUnique({
            where: { id: runId },
            select: {
                id: true,
                startedById: true,
                repo: { select: { ownerId: true, repoFullName: true } }
            }
        });
        if (!run) return;
        const userId = run.startedById ?? run.repo.ownerId;
        if (!userId) return;
        const t = await wordsFor(userId, "notices");
        const repo = run.repo.repoFullName;
        await notify({
            userId,
            event: "agent.run",
            title:
                state === "succeeded"
                    ? t("agents.runSucceededTitle", { repo })
                    : t("agents.runFailedTitle", { repo }),
            body: state === "succeeded" ? t("agents.runSucceededBody") : t("agents.runFailedBody"),
            href: runHref(run.id),
            level: state === "succeeded" ? "success" : "danger",
            metadata: { runId: run.id, state }
        });
    } catch (error) {
        quietly(`run ${runId}`, error);
    }
}
