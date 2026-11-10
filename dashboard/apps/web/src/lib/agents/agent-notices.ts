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
import { notify, pushNotice } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";

export const WAITING_EVENT = "agent.waiting";

/** One notification per session on a device: a later push replaces the earlier. */
export function sessionPushTag(sessionId: string): string {
    return `agent-session:${sessionId}`;
}

/** Where a session's page in the Agents app used to be. Kept only so notices
 *  raised before sessions moved to Polar are still found again; it redirects. */
function legacySessionHref(sessionId: string): string {
    return `/apps/agents/sessions/${sessionId}`;
}

/** The same session opened in Polar's Code side. */
export function polarSessionHref(sessionId: string): string {
    return `/polar?session=${sessionId}`;
}

/** Every page a session's notices may point at, for finding them again. */
function sessionHrefs(sessionId: string): string[] {
    return [legacySessionHref(sessionId), polarSessionHref(sessionId)];
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
            href: polarSessionHref(subject.id),
            actionRequired: true,
            metadata: { sessionId: subject.id },
            push: { tag: sessionPushTag(subject.id), requireInteraction: true }
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
                href: { in: sessionHrefs(sessionId) },
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
            where: { type: WAITING_EVENT, href: { in: sessionHrefs(sessionId) }, userId, readAt: null },
            data: { readAt: new Date() }
        });
    } catch (error) {
        quietly(`session ${sessionId} opened`, error);
    }
}

/** The route a notification's button answers a permission prompt through. */
const PERMISSION_ANSWER_URL = "/api/agents/sessions/permission";

/** "Always" last, so a device that draws only two buttons keeps the two that
 *  answer this prompt alone. */
const CHOICE_WORDS = {
    allow: "agents.permissionAllow",
    deny: "agents.permissionDeny",
    always: "agents.permissionAlways"
} as const;

/**
 * A permission prompt Polaris can answer: pushed to the owner's devices with
 * Allow and Deny on the notification itself, in place of the "needs you" one.
 * The bell already holds that one, so no second row is written.
 */
export async function pushPermissionRequest(
    sessionId: string,
    requestId: string,
    detail: string
): Promise<void> {
    try {
        const subject = await sessionSubject(sessionId);
        if (!subject?.ownerId) return;
        const t = await wordsFor(subject.ownerId, "notices");
        await pushNotice({
            userId: subject.ownerId,
            event: WAITING_EVENT,
            title: t("agents.permissionTitle", { session: subject.title }),
            body: detail || t("agents.waitingBody"),
            href: polarSessionHref(subject.id),
            push: {
                tag: sessionPushTag(subject.id),
                requireInteraction: true,
                actions: (["allow", "deny", "always"] as const).map((choice) => ({
                    action: choice,
                    title: t(CHOICE_WORDS[choice]),
                    request: { url: PERMISSION_ANSWER_URL, body: { requestId, choice } }
                }))
            }
        });
    } catch (error) {
        quietly(`session ${sessionId} permission`, error);
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
            href: polarSessionHref(subject.id),
            level: reason === "exited" ? "info" : reason === "failed" ? "danger" : "warning",
            metadata: { sessionId: subject.id, reason },
            push: { tag: sessionPushTag(subject.id) }
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
            href: polarSessionHref(subject.id),
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
                href: { in: sessionHrefs(sessionId) },
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
            event: state === "succeeded" ? "agent.run.succeeded" : "agent.run",
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

/** The account's automatic runs were paused because the provider ran out of credit. */
export async function noticeRunsPausedForCredit(ownerId: string, runId: string): Promise<void> {
    try {
        const t = await wordsFor(ownerId, "notices");
        await notify({
            userId: ownerId,
            event: "agent.run",
            title: t("agents.pausedCreditsTitle"),
            body: t("agents.pausedCreditsBody"),
            href: "/apps/agents/runs",
            level: "danger",
            actionRequired: true,
            metadata: { runId, paused: "credits" }
        });
    } catch (error) {
        quietly(`credit pause after run ${runId}`, error);
    }
}
