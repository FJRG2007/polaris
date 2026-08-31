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

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as taskAccess from "@/lib/tasks/access";
import { addComment } from "@/lib/tasks/task-detail-service";

const SESSIONS_PATH = "/apps/agents/sessions";

/** The agents Polaris can offer, and where a session could run. Read by the
 *  start dialog, which cannot import the catalogue's detection itself: probing a
 *  machine is a server's job. */
export async function sessionChoicesAction(): Promise<{
    agents: { id: string; label: string; vendor: string; install: string | null; docs: string }[];
    repos: { id: string; name: string }[];
    hosts: { id: string; name: string }[];
}> {
    const user = await requirePermission("agents.manage");
    const [repos, hosts] = await Promise.all([
        prisma.agentRepo.findMany({
            where: { ownerId: user.id, enabled: true },
            select: { id: true, repoFullName: true },
            orderBy: { repoFullName: "asc" }
        }),
        prisma.host.findMany({
            where: { ownerId: user.id, status: "active" },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        })
    ]);
    return {
        agents: core.AGENT_CLIS.map((cli) => ({
            id: cli.id,
            label: cli.label,
            vendor: cli.vendor,
            install: cli.install,
            docs: cli.docs
        })),
        repos: repos.map((repo) => ({ id: repo.id, name: repo.repoFullName })),
        hosts
    };
}

export async function listSessionsAction(): Promise<sessions.SessionView[]> {
    const user = await requirePermission("agents.read");
    return sessions.listSessions(user.id);
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
export async function startSessionAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = core.startAgentSessionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    const value = parsed.data;

    const repo = await prisma.agentRepo.findFirst({
        where: { id: value.repoId, ownerId: user.id },
        select: { id: true }
    });
    if (!repo) return { error: "That repository is not connected to the Agents app." };

    // Which server a session may run on is settled here, once. The runtime reads
    // the host without an owner check afterwards, and this is the check it is
    // relying on.
    if (value.place === "host") {
        const host = await prisma.host.findFirst({
            where: { id: value.hostId ?? "", ownerId: user.id },
            select: { id: true }
        });
        if (!host) return { error: "That server is not one of yours." };
    }

    const { session, token } = await sessions.createSession({
        repoId: value.repoId,
        startedById: user.id,
        title: value.title,
        cli: value.cli,
        command: value.cli === core.CUSTOM_AGENT_CLI ? (value.command ?? null) : null,
        place: value.place,
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
        return { id: session.id, error: error instanceof Error ? error.message : "It would not start" };
    }

    if (value.prompt) {
        await sessions.addSessionMessage(session.id, "user", value.prompt, user.id);
        // Best effort: the agent may still be installing itself. A prompt that did
        // not land is worth reporting on the session rather than failing the start
        // that otherwise worked.
        await runtime.promptSession(session.id, value.prompt).catch(async (error: unknown) => {
            await sessions.addSessionMessage(
                session.id,
                "system",
                `Polaris could not send the first prompt: ${error instanceof Error ? error.message : "unknown"}`
            );
        });
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
        await taskAccess.requireTask({ id: userId, isAdmin: false }, session.taskId, "guest");
        await addComment(userId, {
            taskId: session.taskId,
            body: `Handed to an agent. It is working on \`${session.branch}\` in ${session.repoFullName}: [the session](/apps/agents/sessions/${session.id}).`,
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
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Say something" };

    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: "That session no longer exists." };
    if (core.isSessionOver(session.state)) return { error: "That session has ended." };

    await sessions.addSessionMessage(session.id, "user", parsed.data.text, user.id);
    try {
        await runtime.promptSession(session.id, parsed.data.text);
    } catch (error) {
        return { error: error instanceof Error ? error.message : "It did not go through" };
    }
    revalidatePath(`${SESSIONS_PATH}/${session.id}`);
    return {};
}

export async function interruptSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: "That session no longer exists." };
    try {
        await runtime.interruptSession(sessionId);
    } catch (error) {
        return { error: error instanceof Error ? error.message : "It did not go through" };
    }
    revalidatePath(`${SESSIONS_PATH}/${sessionId}`);
    return {};
}

export async function stopSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: "That session no longer exists." };
    await runtime.stopSession(sessionId);
    revalidatePath(SESSIONS_PATH);
    return {};
}

/** What the agent's terminal shows right now, for the panel that would rather
 *  show the last few lines than open a full terminal to every session. */
export async function sessionScreenAction(sessionId: string): Promise<{ screen?: string; error?: string }> {
    const user = await requirePermission("agents.read");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: "That session no longer exists." };
    if (core.isSessionOver(session.state)) return { screen: "" };
    try {
        return { screen: await runtime.captureSession(sessionId) };
    } catch {
        return { error: "The machine running this session did not answer." };
    }
}
