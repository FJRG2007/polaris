"use server";

/**
 * Starting and steering a live agent session.
 *
 * Every one of these re-resolves what it is acting on rather than trusting what
 * the screen last saw. A session page can be open for hours - which is the point
 * of a session - so by the time somebody types into it the repository may have
 * been removed, the server it runs on may have been deleted, and the session
 * itself may have ended.
 */

import { z } from "zod";
import { after } from "next/server";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as taskAccess from "@/lib/tasks/access";
import { requirePermission } from "@/lib/session";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as work from "@/lib/agents/session-work";
import { sessionCursorSchema } from "@/lib/agents/session-cursor";
import * as review from "@/lib/agents/session-review";
import { appBaseUrl } from "@/lib/domain-service";
import { safeChangePath } from "@/lib/agents/session-changes";
import { addComment } from "@/lib/tasks/task-detail-service";
import { agentChoicesFor, agentOptionsFor, type AgentOption } from "@/lib/agents/agent-readiness";
import {
    capacityRefusal,
    sessionCapacity,
    sharedWorkspaceAllowed,
    workspaceHolders,
    workspaceRefusal
} from "@/lib/agents/session-capacity";
import { getTranslations } from "@/lib/i18n/request";
import { wordsFor } from "@/lib/notifications/notice-words";
import { agentText, knownAgentText } from "@/lib/agents/words";
import {
    githubInstallGapForRepo,
    installGapMessage,
    type GithubInstallGap
} from "@/lib/github-app-reach";

const SESSIONS_PATH = "/apps/agents/sessions";

/**
 * The agents Polaris can offer, and where a session could run.
 *
 * Each agent arrives knowing whether this account can actually sign it in, which
 * is the question the dialog was not asking. It is answered here rather than in
 * the dialog because it is a question about stored credentials, and nothing in a
 * browser is ever told which ones exist - only whether one does.
 */
export async function sessionChoicesAction(): Promise<{
    agents: AgentOption[];
    repos: { id: string; name: string }[];
    hosts: { id: string; name: string }[];
    /** Whether this deployment offers a machine everybody shares. */
    sharedWorkspace: boolean;
}> {
    const user = await requirePermission("agents.manage");
    const [repos, hosts, sharedWorkspace] = await Promise.all([
        prisma.agentRepo.findMany({
            where: { ownerId: user.id, enabled: true },
            select: { id: true, repoFullName: true },
            orderBy: { repoFullName: "asc" }
        }),
        prisma.host.findMany({
            where: { ownerId: user.id, status: "active" },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        sharedWorkspaceAllowed()
    ]);
    return {
        sharedWorkspace,
        agents: await agentOptionsFor(user.id),
        repos: repos.map((repo) => ({ id: repo.id, name: repo.repoFullName })),
        hosts
    };
}

const listPage = z
    .object({ mine: z.boolean().optional(), after: sessionCursorSchema.optional() })
    .strict();

export async function listSessionsAction(
    limit?: number,
    page?: { mine?: boolean; after?: string }
): Promise<sessions.SessionView[]> {
    const user = await requirePermission("agents.read");
    const take = z.number().int().positive().optional().safeParse(limit);
    const where = listPage.safeParse(page ?? {});
    // A page that does not parse lists nothing rather than everything.
    if (!where.success) return [];
    return sessions.listSessions(user.id, {
        limit: take.success ? take.data : undefined,
        ...where.data
    });
}

export async function sessionDetailAction(sessionId: string): Promise<{
    session: sessions.SessionView;
    events: { kind: string; detail: string; subject: string; at: string }[];
    messages: { role: string; body: string; authorId: string | null; at: string }[];
} | null> {
    const user = await requirePermission("agents.read");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return null;
    const [events, messages] = await Promise.all([
        sessions.sessionEvents(sessionId),
        sessions.sessionMessages(sessionId)
    ]);
    return { session, events, messages };
}

/**
 * Start a session.
 *
 * The row is created before the machine is touched, so a session that failed to
 * start is a session somebody can look at and read the reason on - rather than a
 * click that produced an error toast and no trace of what was attempted.
 */
export async function startSessionAction(
    input: unknown
): Promise<{ id?: string; error?: string; githubGap?: GithubInstallGap }> {
    const user = await requirePermission("agents.manage");
    const parsed = core.startAgentSessionSchema.safeParse(input);
    const t = await getTranslations("agents");
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return {
            error: (message ? knownAgentText(t, message) : null) ?? t("sessions.errors.checkForm")
        };
    }
    const value = parsed.data;

    // Only when one was named. A workspace checks nothing out, so there is no
    // repository to own and nothing to verify - what it is allowed to be is
    // settled by who is asking, which `requirePermission` already answered.
    if (value.repoId) {
        const repo = await prisma.agentRepo.findFirst({
            where: { id: value.repoId, ownerId: user.id },
            select: { id: true, repoFullName: true }
        });
        if (!repo) return { error: t("sessions.errors.repoNotConnected") };
        // The clone goes out as this person's linked account, which reaches only
        // what Polaris's App is installed on. Said now, with the button, rather
        // than as a failed clone on a session row.
        const gap = await githubInstallGapForRepo(user.id, repo.repoFullName);
        if (gap) {
            const message = installGapMessage(gap, repo.repoFullName);
            return { error: t(message.key, message.values), githubGap: gap };
        }
    }

    // The machine everybody shares only exists where an administrator said so.
    // Checked here rather than trusted from the form: it is the one option that
    // opens a container holding other people's logins, so a client that asked
    // for it without the deployment offering it is refused rather than served.
    if (value.sharedHome && !(await sharedWorkspaceAllowed())) {
        return { error: t("sessions.errors.noSharedMachine") };
    }

    // Which server a session may run on is settled here, once. The runtime reads
    // the host without an owner check afterwards, and this is the check it is
    // relying on.
    if (value.place === "host") {
        const host = await prisma.host.findFirst({
            where: { id: value.hostId ?? "", ownerId: user.id },
            select: { id: true }
        });
        if (!host) return { error: t("sessions.errors.serverNotYours") };
    }

    // Before anything else, because it is the cheapest question and the one whose
    // answer does not change with the form: a box already running as many
    // containers as it is set to should not be asked to check credentials first.
    const refusal = capacityRefusal(await sessionCapacity(user.id));
    if (refusal) return { error: agentText(t, refusal) };

    // A workspace opens on a directory that outlives it, and every workspace
    // session on that machine opens on the same one. Two at once is two agents
    // editing each other's files and, because this session's reporting token is
    // written into that directory, the later boot's credential answering for the
    // earlier session.
    if (!value.repoId) {
        const claim = {
            userId: user.id,
            place: value.place,
            sharedHome: value.sharedHome,
            hostId: value.place === "host" ? (value.hostId ?? null) : null
        };
        const taken = workspaceRefusal(claim, await workspaceHolders(claim));
        if (taken) return { error: agentText(t, taken) };
    }

    // Before a row exists, because a session that could never have signed in is
    // not a record of an attempt - it is a dead row somebody has to notice and
    // clear. Only `missing` refuses: `unknown` is a tool Polaris holds no sourced
    // credential for, and refusing on that would be inventing a problem. A session
    // on a server the person already signed the tool in on is `missing` too, which
    // is why the message says so rather than insisting.
    // Only the tool matters here: an option that names an account is an account
    // that exists, so it can never be the missing case. Neither can the machine's
    // own login: it is the answer for exactly the tool Polaris holds nothing for,
    // so refusing it here would refuse the case the option exists for.
    const blocked =
        value.accountId || value.useMachineLogin
            ? undefined
            : (await agentChoicesFor(user.id)).find(
                  (agent) => agent.id === value.cli && agent.readiness === "missing"
              );
    if (blocked) {
        const ways = blocked.missing
            .map((credential) => credential.label)
            .join(` ${t("sessions.errors.or")} `);
        return {
            error:
                value.place === "host"
                    ? t("sessions.errors.signInHost", { agent: blocked.label, ways })
                    : t("sessions.errors.signInLocal", { agent: blocked.label, ways })
        };
    }

    // A session names the task it was started for, and that association is what
    // puts a note on somebody else's board. Checked here rather than only when
    // the note is written, where a refusal is swallowed and the id stays stored.
    if (value.taskId) {
        try {
            await taskAccess.requireTask({ id: user.id, isAdmin: false }, value.taskId, "guest");
        } catch {
            return { error: t("sessions.errors.taskUnreachable") };
        }
    }

    const { session, token } = await sessions.createSession({
        repoId: value.repoId,
        startedById: user.id,
        title: value.title,
        cli: value.cli,
        command: value.cli === core.CUSTOM_AGENT_CLI ? (value.command ?? null) : null,
        place: value.place,
        sharedHome: value.sharedHome,
        unattended: value.unattended,
        accountId: value.accountId,
        useMachineLogin: value.useMachineLogin,
        hostId: value.place === "host" ? value.hostId : null,
        baseRef: value.baseRef,
        taskId: value.taskId,
        enigma: value.enigma
            ? {
                  enabled: value.enigma.enabled ?? null,
                  scope: value.enigma.scope ?? null,
                  gate: value.enigma.gate ?? null,
                  version: value.enigma.version ?? null,
                  config: value.enigma.config ?? null
              }
            : null
    });

    try {
        await runtime.startSession(session, token);
    } catch (error) {
        revalidatePath(SESSIONS_PATH);
        return {
            id: session.id,
            error: agentText(t, sessions.readableFailure(error, `starting ${session.id}`))
        };
    }

    if (value.prompt) {
        await sessions.addSessionMessage(session.id, "user", value.prompt, user.id);
        // After the response rather than before it, because the agent does not
        // exist yet: the container is still cloning the repository and installing
        // the tool. Holding the click open for that would tie a start to a minute
        // of somebody else's network, and sending the prompt now would send it to
        // a terminal that is not there. The delivery waits, and writes into the
        // transcript if it never gets a terminal to type into.
        const prompt = value.prompt;
        after(() => runtime.deliverFirstPrompt(session.id, prompt));
    }

    await noteOnTask(session, user.id);
    revalidatePath(SESSIONS_PATH);
    return { id: session.id };
}

/**
 * Tell the task where its work went.
 *
 * A comment rather than a field on the task. The board's question is "what is
 * happening with this", and a line in the conversation answers it for everybody
 * looking at the task - including the people who do not use the Agents app and
 * would never think to go looking for a session.
 *
 * Best effort and deliberately quiet: a session that started is not a failure
 * because the note did not land, and the person who started it is already looking
 * at the session rather than at the task.
 */
async function noteOnTask(session: sessions.SessionView, userId: string): Promise<void> {
    if (!session.taskId) return;
    try {
        // Asked again rather than assumed: the start settled it, and a comment on
        // somebody's board is not a write to make on the strength of that alone.
        await taskAccess.requireTask({ id: userId, isAdmin: false }, session.taskId, "guest");
        // Written in the words of whoever handed it over: it is their comment.
        const t = await wordsFor(userId, "agents");
        await addComment(userId, {
            taskId: session.taskId,
            body: t("sessions.taskNote", {
                branch: session.branch ?? "",
                repo: session.repoFullName ?? "",
                href: `/apps/agents/sessions/${session.id}`
            }),
            parentId: null,
            assignedToId: null
        });
    } catch {
        // The session is what matters and it exists.
    }
}

export async function promptSessionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = core.agentSessionPromptSchema.safeParse(input);
    const t = await getTranslations("agents");
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return {
            error:
                (message ? knownAgentText(t, message) : null) ?? t("sessions.errors.saySomething")
        };
    }

    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (core.isSessionOver(session.state)) return { error: t("sessions.errors.ended") };

    await sessions.addSessionMessage(session.id, "user", parsed.data.text, user.id);
    try {
        await runtime.promptSession(session.id, parsed.data.text);
    } catch (error) {
        return { error: agentText(t, sessions.readableFailure(error, `prompting ${session.id}`)) };
    }
    revalidatePath(`${SESSIONS_PATH}/${session.id}`);
    return {};
}

export async function interruptSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    try {
        await runtime.interruptSession(sessionId);
    } catch (error) {
        return {
            error: agentText(t, sessions.readableFailure(error, `interrupting ${sessionId}`))
        };
    }
    revalidatePath(`${SESSIONS_PATH}/${sessionId}`);
    return {};
}

export async function stopSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: (await getTranslations("agents"))("sessions.errors.gone") };
    await runtime.stopSession(sessionId);
    revalidatePath(SESSIONS_PATH);
    // And the session's own page, which is where the button was pressed. Only
    // the list was revalidated, so the screen somebody was actually looking at
    // waited for its next poll to notice.
    revalidatePath(`${SESSIONS_PATH}/${sessionId}`);
    return {};
}

/**
 * Try again to push the work a stopped session kept. On success the container
 * goes, exactly as it would have on Stop; otherwise it stays and says so.
 */
export async function retrySessionPushAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (session.work?.state !== "kept") return {};
    const outcome = await work.endContainerSession(sessionId);
    revalidatePath(`${SESSIONS_PATH}/${sessionId}`);
    if (outcome.kind === "kept") return { error: t("session.work.retryFailed") };
    return {};
}

/** Let the work a stopped session kept go, with its container. */
export async function discardSessionWorkAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (session.work?.state !== "kept") return {};
    await work.discardSessionWork(sessionId);
    revalidatePath(`${SESSIONS_PATH}/${sessionId}`);
    return {};
}

/** What the agent's terminal shows right now, for the panel that would rather
 *  show the last few lines than open a full terminal to every session. */
export async function sessionScreenAction(
    sessionId: string
): Promise<{ screen?: string; error?: string }> {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (core.isSessionOver(session.state)) return { screen: "" };
    try {
        return { screen: await runtime.captureSession(sessionId) };
    } catch {
        return { error: t("sessions.errors.noAnswer") };
    }
}

// ---------------------------------------------------------------------------
// Changes and pull requests
//
// Reading a session's checkout runs commands on its machine, and shipping pushes
// from it, so both are for whoever may steer the session - the same
// `agents.manage` and the same ownership check every other control here uses.
// ---------------------------------------------------------------------------

const sessionIdSchema = z.string().trim().uuid();

const changesInputSchema = z.object({
    sessionId: sessionIdSchema,
    offset: z.number().int().min(0).max(1_000_000).default(0)
});

const fileDiffInputSchema = z.object({
    sessionId: sessionIdSchema,
    path: z.string().min(1).max(4096).refine(safeChangePath)
});

const openPullInputSchema = z.object({
    sessionId: sessionIdSchema,
    title: z.string().trim().min(1).max(256),
    body: z.string().trim().max(60_000)
});

/** The session, when this account may steer it. */
async function controlledSession(sessionId: string): Promise<sessions.SessionView | null> {
    const user = await requirePermission("agents.manage");
    return sessions.getSession(sessionId, user.id);
}

export async function sessionChangesAction(
    input: unknown
): Promise<{ answer?: review.ChangesAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = changesInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await review.listSessionChanges(session, parsed.data.offset) };
}

export async function sessionFileDiffAction(
    input: unknown
): Promise<{ answer?: review.DiffAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = fileDiffInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await review.sessionFileDiff(session, parsed.data.path) };
}

export interface SessionShipView {
    /** Why the button is not offered, or null when it is. */
    blocked: review.ShipRefusal | null;
    draft: { title: string; body: string };
    /** The linked pull request as GitHub has it now; `state` is null when
     *  GitHub would not say. */
    pull: {
        number: number;
        url: string;
        title: string;
        state: "open" | "closed" | "merged" | null;
    } | null;
}

/** What the ship button needs: whether it may be offered, the draft it opens
 *  with, and the pull request the session already links. */
export async function sessionShipAction(
    input: unknown
): Promise<{ view?: SessionShipView; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data);
    if (!session) return { error: t("sessions.errors.gone") };
    const [push, live, first, base] = await Promise.all([
        review.sessionPushSetting(session.id),
        review.linkedPullRequest(session).catch(() => null),
        prisma.agentSessionMessage.findFirst({
            where: { sessionId: session.id, role: "user" },
            orderBy: { createdAt: "asc" },
            select: { body: true }
        }),
        appBaseUrl()
    ]);
    const linked = session.pullRequest;
    return {
        view: {
            blocked: review.shipBlocked(session, push),
            draft: review.pullRequestDraft({
                title: session.title,
                prompt: first?.body ?? null,
                sessionUrl: `${base.replace(/\/+$/, "")}${SESSIONS_PATH}/${session.id}`,
                words: {
                    fallbackTitle: t("session.ship.draftTitle"),
                    asked: t("session.ship.draftAsked"),
                    openedFrom: (url) => t("session.ship.draftFrom", { url })
                }
            }),
            pull: linked
                ? {
                      number: linked.number,
                      url: live?.url ?? linked.url,
                      title: live?.title ?? "",
                      state: live?.state ?? null
                  }
                : null
        }
    };
}

/** Push the branch and open its pull request, or link the one it already has. */
export async function openSessionPullRequestAction(
    input: unknown
): Promise<{ pull?: { number: number; url: string; existing: boolean }; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = openPullInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.ship.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    const result = await review.openSessionPullRequest(
        session,
        await review.sessionPushSetting(session.id),
        { title: parsed.data.title, body: parsed.data.body }
    );
    revalidatePath(`${SESSIONS_PATH}/${session.id}`);
    if (result.kind === "refused") {
        if (result.reason === "push")
            return { error: t(`session.work.reasons.${result.pushReason ?? "other"}`) };
        return { error: t(`session.ship.refusals.${result.reason}`) };
    }
    return {
        pull: {
            number: result.pull.number,
            url: result.pull.url,
            existing: result.kind === "existing"
        }
    };
}
