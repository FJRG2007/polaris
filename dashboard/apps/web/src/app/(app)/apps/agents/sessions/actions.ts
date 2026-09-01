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
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as taskAccess from "@/lib/tasks/access";
import { addComment } from "@/lib/tasks/task-detail-service";
import { agentChoicesFor, agentOptionsFor, type AgentOption } from "@/lib/agents/agent-readiness";
import {
    capacityRefusal,
    sessionCapacity,
    sharedWorkspaceAllowed,
    workspaceHolders,
    workspaceRefusal
} from "@/lib/agents/session-capacity";

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

    // Only when one was named. A workspace checks nothing out, so there is no
    // repository to own and nothing to verify - what it is allowed to be is
    // settled by who is asking, which `requirePermission` already answered.
    if (value.repoId) {
        const repo = await prisma.agentRepo.findFirst({
            where: { id: value.repoId, ownerId: user.id },
            select: { id: true }
        });
        if (!repo) return { error: "That repository is not connected to the Agents app." };
    }

    // The machine everybody shares only exists where an administrator said so.
    // Checked here rather than trusted from the form: it is the one option that
    // opens a container holding other people's logins, so a client that asked
    // for it without the deployment offering it is refused rather than served.
    if (value.sharedHome && !(await sharedWorkspaceAllowed())) {
        return { error: "This Polaris does not offer a shared machine." };
    }

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

    // Before anything else, because it is the cheapest question and the one whose
    // answer does not change with the form: a box already running as many
    // containers as it is set to should not be asked to check credentials first.
    const refusal = capacityRefusal(await sessionCapacity(user.id));
    if (refusal) return { error: refusal };

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
        if (taken) return { error: taken };
    }

    // Before a row exists, because a session that could never have signed in is
    // not a record of an attempt - it is a dead row somebody has to notice and
    // clear. Only `missing` refuses: `unknown` is a tool Polaris holds no sourced
    // credential for, and refusing on that would be inventing a problem. A session
    // on a server the person already signed the tool in on is `missing` too, which
    // is why the message says so rather than insisting.
    // Only the tool matters here: an option that names an account is an account
    // that exists, so it can never be the missing case.
    const blocked = value.accountId
        ? undefined
        : (await agentChoicesFor(user.id)).find(
              (agent) => agent.id === value.cli && agent.readiness === "missing"
          );
    if (blocked) {
        const ways = blocked.missing.map((credential) => credential.label).join(" or ");
        return {
            error:
                value.place === "host"
                    ? `Nothing here signs ${blocked.label} in. Either sign it in on that server yourself, or add ${ways} under AI keys.`
                    : `Nothing here signs ${blocked.label} in, so it would start and sit at its own login prompt. Add ${ways} under AI keys.`
        };
    }

    // A session names the task it was started for, and that association is what
    // puts a note on somebody else's board. Checked here rather than only when
    // the note is written, where a refusal is swallowed and the id stays stored.
    if (value.taskId) {
        try {
            await taskAccess.requireTask({ id: user.id, isAdmin: false }, value.taskId, "guest");
        } catch {
            return { error: "That task is not one you can reach." };
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
        return { id: session.id, error: sessions.readableFailure(error, `starting ${session.id}`) };
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
        return { error: sessions.readableFailure(error, `prompting ${session.id}`) };
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
        return { error: sessions.readableFailure(error, `interrupting ${sessionId}`) };
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
export async function sessionScreenAction(
    sessionId: string
): Promise<{ screen?: string; error?: string }> {
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
