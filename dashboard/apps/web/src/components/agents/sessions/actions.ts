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

import { permissionRulesSchema, type PermissionRule } from "@/lib/polar/agents/permissions";
import { z } from "zod";
import { computerFor } from "@/lib/computers/computer-service";
import { sendToRunner } from "@/lib/computers/computer-commands";
import * as computerProgress from "@/lib/computers/computer-progress";
import { onRunnerLive } from "@/lib/computers/computer-bus";
import { after } from "next/server";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as acpProviders from "@/lib/agents/acp/providers";
import * as taskAccess from "@/lib/tasks/access";
import { requirePermission, requireUser } from "@/lib/session";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as permissions from "@/lib/agents/session-permissions";
import * as queue from "@/lib/agents/session-queue";
import * as work from "@/lib/agents/session-work";
import * as repoOptions from "@/lib/agents/repo-options";
import { sessionCursorSchema } from "@/lib/agents/session-cursor";
import * as review from "@/lib/agents/session-review";
import * as turns from "@/lib/agents/session-snapshot-service";
import { COMMIT_PATTERN } from "@/lib/agents/session-snapshots";
import * as timelines from "@/lib/agents/session-pr-timeline";
import * as reviewer from "@/lib/agents/session-reviewer";
import { requestReview } from "@/lib/agents/session-reviewer-service";
import * as files from "@/lib/agents/session-files";
import * as artifacts from "@/lib/agents/session-artifacts";
import * as preview from "@/lib/agents/session-preview";
import * as history from "@/lib/agents/session-history";
import * as rotation from "@/lib/agents/account-rotation";
import { appBaseUrl } from "@/lib/domain-service";
import { safeChangePath } from "@/lib/agents/session-changes";
import { addComment } from "@/lib/tasks/task-detail-service";
import { noteIssueOfPull } from "@/lib/agents/issue-sessions";
import * as loop from "@/lib/agents/session-review-loop";
import * as forking from "@/lib/agents/session-fork";
import { mergePullRequest, pullRequestChecks } from "@/lib/github-service";
import { agentChoicesFor, agentOptionsFor, type AgentOption } from "@/lib/agents/agent-readiness";
import { chatCredentialFor } from "@/lib/agents/model-keys";
import * as sessionAttachments from "@/lib/agents/session-attachments";
import * as promptQueue from "@/lib/agents/session-prompt-queue";
import {
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

/** Where a session is opened: Polar's Code side. */
const polarSession = (id: string) => `/polar?session=${id}`;

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
    /** Where the repositories after `repos` start, or null when that is all. */
    reposNext: string | null;
    /** Whether this deployment offers a machine everybody shares. */
    sharedWorkspace: boolean;
}> {
    const user = await requirePermission("agents.manage");
    // The first page only: it names the default and says whether there are
    // any. The picker reads the rest through `repoOptionsAction`.
    const [repos, sharedWorkspace] = await Promise.all([
        repoOptions.firstRepoPage(user.id),
        sharedWorkspaceAllowed()
    ]);
    return {
        sharedWorkspace,
        agents: await agentOptionsFor(user.id),
        repos: repos.items,
        reposNext: repos.next
    };
}

/** A page of the repositories a session can start on, or the ones named by id. */
export async function repoOptionsAction(
    input: unknown
): Promise<{ items: repoOptions.RepoOption[]; next: string | null } | { error: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = repoOptions.repoOptionsInput.safeParse(input ?? {});
    if (!parsed.success) return { error: "invalid" };
    return repoOptions.repoOptionsPage(user.id, parsed.data);
}

const listPage = z
    .object({
        mine: z.boolean().optional(),
        after: sessionCursorSchema.optional(),
        polar: z.boolean().optional()
    })
    .strict();

export async function listSessionsAction(
    limit?: number,
    page?: { mine?: boolean; after?: string; polar?: boolean }
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
    input: unknown,
    /** The rules of the Polar agent the task runs as (`lib/polar/agents/permissions`).
     *  Only ever narrows or settles the person's own session's prompts. */
    rules: unknown = []
): Promise<{
    id?: string;
    error?: string;
    githubGap?: GithubInstallGap;
    /** Where it stands in the queue, when every slot was taken. */
    queuedAt?: number | null;
}> {
    const user = await requirePermission("agents.manage");
    const parsed = core.startAgentSessionSchema.safeParse(input);
    const t = await getTranslations("agents");
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return {
            error: (message ? knownAgentText(t, message) : null) ?? t("sessions.errors.checkForm")
        };
    }
    return startParsed(user.id, parsed.data, t, null, permissionRulesSchema.catch([]).parse(rules));
}

/** Everything a start checks and does once the form has parsed. `fork` names
 *  the session it is a fork of, and that session's Enigma choices, which the
 *  form has no way to carry. */
async function startParsed(
    userId: string,
    value: core.StartAgentSessionInput,
    t: Awaited<ReturnType<typeof getTranslations>>,
    fork: { parentId: string; enigma: core.EnigmaSettings | null } | null,
    agentPermission: PermissionRule[] = []
): Promise<{ id?: string; error?: string; githubGap?: GithubInstallGap; queuedAt?: number | null }> {
    const user = { id: userId };

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

    // Same for a computer: the runtime sends to the runner the row names, and
    // this is the check that it is the starter's own. An offline one is said
    // now rather than as a failed session.
    if (value.place === "computer") {
        const owned = await computerFor(user.id, value.runnerId ?? "");
        if (!owned) return { error: t("sessions.errors.computerNotYours") };
        if (!owned.online) return { error: t("text.computerOffline", { name: owned.name }) };
    }

    // Several sessions of one person may share a workspace (see
    // `workspaceRefusal`); only the shared machine held by somebody else refuses.
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
    // A model picked on the form signs the tool in with that provider's key,
    // which is checked here rather than the tool's own sign-in.
    // Only for a tool that runs on a provider's key; one that only takes the
    // model's name signs in with its own account, checked below.
    const keyed = Boolean(value.modelChoice) && core.MODEL_CHOICE_AGENT_CLIS.includes(value.cli);
    if (value.modelChoice && keyed) {
        const credential = await chatCredentialFor(
            user.id,
            value.modelChoice.provider,
            value.modelChoice.payer
        );
        if (!credential) return { error: t("sessions.errors.noModelKey") };
    }
    const files = await sessionAttachments.sessionAttachmentsFor(user.id, value.attachments);
    if ("refusal" in files) return { error: t(`sessions.errors.files.${files.refusal}`) };

    const blocked =
        // A computer signs its tools in itself; nothing Polaris holds is asked for.
        value.place === "computer" || value.accountId || value.useMachineLogin || keyed
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

    // Over a ceiling this queues rather than refuses: the session is written
    // down now and starts when a slot frees, with its place shown on the list.
    let admission: Awaited<ReturnType<typeof queue.admitSession>>;
    try {
        admission = await queue.admitSession(
            {
        repoId: value.repoId,
        startedById: user.id,
        agentPermission,
        title: value.title,
        cli: value.cli,
        command: value.cli === core.CUSTOM_AGENT_CLI ? (value.command ?? null) : null,
        place: value.place,
        sharedHome: value.sharedHome,
        unattended: value.unattended,
        permissionMode: value.permissionMode,
        effort: value.effort,
        accountId: value.accountId,
        useMachineLogin: value.useMachineLogin,
        modelChoice: value.modelChoice,
        hostId: value.place === "host" ? value.hostId : null,
        runnerId: value.place === "computer" ? value.runnerId : null,
        localFolder: value.place === "computer" ? value.localFolder : "",
        baseRef: value.baseRef,
        taskId: value.taskId,
        parentId: fork?.parentId ?? null,
        enigma: fork
            ? fork.enigma
            : value.enigma
            ? {
                  enabled: value.enigma.enabled ?? null,
                  scope: value.enigma.scope ?? null,
                  gate: value.enigma.gate ?? null,
                  version: value.enigma.version ?? null,
                  config: value.enigma.config ?? null,
                  skillsOff: value.enigma.skillsOff ?? null
              }
            : null
    },
            value.prompt || null
        );
    } catch (error) {
        if (error instanceof sessions.SessionRefusal) return { error: agentText(t, error.message) };
        throw error;
    }
    const { session } = admission;
    if (admission.startError) {
        return {
            id: session.id,
            error: agentText(t, sessions.readableFailure(admission.startError, `starting ${session.id}`))
        };
    }

    if (value.prompt && admission.queuedAt === null) {
        const prompt = sessionAttachments.withAttachmentNote(
            value.prompt,
            files.files.map((file) => file.path)
        );
        // After the response rather than before it, because the agent does not
        // exist yet: the container is still cloning the repository and installing
        // the tool. The delivery waits, and writes into the transcript if it never
        // gets a terminal to type into. A queued session is handed it by the queue.
        const carried = files.files.length > 0 ? { session, userId: user.id, files: files.files } : null;
        after(() => runtime.deliverFirstPrompt(session.id, prompt, carried));
    } else if (admission.queuedAt !== null && files.files.length > 0) {
        // The queue starts it later with the prompt alone: the files have no
        // machine to go to yet, and saying so beats a prompt about files that
        // never arrived.
        await sessions.addSessionMessage(
            session.id,
            "system",
            "The attached files were not kept while this session waited for a slot. Attach them again once it starts."
        );
    }

    await noteOnTask(session, user.id);
    return { id: session.id, queuedAt: admission.queuedAt };
}

/** Where a fork runs instead of its parent's machine. */
export interface SessionPlace {
    place: core.AgentSessionPlace;
    hostId: string | null;
    runnerId: string | null;
}

/**
 * A new session on the same work as another: its branch once that reached
 * GitHub, the same agent, account and machine (or `moveTo`, another one), and - where the agent can fork a
 * conversation and the transcript is in the home the new one opens on - the
 * conversation so far, as a copy the parent never sees. Goes through every check
 * a start does, so a fork is never a way round one.
 */
export async function forkSessionAction(
    sessionId: string,
    moveTo?: SessionPlace
): Promise<{ id?: string; error?: string; githubGap?: GithubInstallGap; queuedAt?: number | null }> {
    const t = await getTranslations("agents");
    const id = sessionIdSchema.safeParse(sessionId);
    if (!id.success) return { error: t("session.changes.errors.invalid") };
    const parent = await controlledSession(id.data);
    if (!parent) return { error: t("sessions.errors.gone") };
    if (!parent.repoId) return { error: t("session.fork.noRepo") };
    const user = await requirePermission("agents.manage");
    const parsed = core.startAgentSessionSchema.safeParse({
        title: parent.title,
        repoId: parent.repoId,
        cli: parent.cli,
        command: parent.command ?? undefined,
        ...(moveTo ?? { place: parent.place, hostId: parent.hostId, runnerId: parent.runnerId }),
        // The shared machine is a home on Polaris; a session moved anywhere
        // else opens in its own.
        sharedHome: moveTo && moveTo.place !== parent.place ? false : parent.sharedHome,
        // A folder chosen on one computer means nothing on another.
        localFolder:
            moveTo && (moveTo.place !== parent.place || moveTo.runnerId !== parent.runnerId)
                ? ""
                : parent.localFolder,
        unattended: parent.unattended,
        permissionMode: parent.permissionMode,
        effort: parent.effort,
        accountId: parent.accountId,
        useMachineLogin: parent.useMachineLogin,
        baseRef: forking.forkBaseRef(parent),
        taskId: parent.taskId
    });
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return {
            error: (message ? knownAgentText(t, message) : null) ?? t("sessions.errors.checkForm")
        };
    }
    const stored = await prisma.agentSession.findUnique({
        where: { id: parent.id },
        select: { enigma: true }
    });
    const enigma = stored?.enigma ? core.parseEnigmaSettings(stored.enigma) : null;
    return startParsed(user.id, parsed.data, t, { parentId: parent.id, enigma });
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
            // A session without a repository has no branch to name.
            body: session.repoFullName
                ? t("sessions.taskNote", {
                      branch: session.branch ?? "",
                      repo: session.repoFullName,
                      href: polarSession(session.id)
                  })
                : t("sessions.taskNoteWorkspace", { href: polarSession(session.id) }),
            parentId: null,
            assignedToId: null
        });
    } catch {
        // The session is what matters and it exists.
    }
}

export async function promptSessionAction(input: unknown): Promise<{ error?: string; queued?: boolean }> {
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
    // No terminal yet. Only the first prompt waits with it; anything after that
    // would be typed into a machine that does not exist.
    if (core.isSessionQueued(session.state)) return { error: t("sessions.errors.queued") };

    // Mid-turn, or behind messages already waiting: it joins the queue and is
    // sent when the turn ends (`session-prompt-queue`).
    if (promptQueue.shouldQueuePrompt(session.state, await promptQueue.queuedCount(session.id))) {
        const files = await sessionAttachments.sessionAttachmentsFor(user.id, parsed.data.attachments);
        if ("refusal" in files) return { error: t(`sessions.errors.files.${files.refusal}`) };
        if (!(await promptQueue.queuePrompt(session.id, user.id, parsed.data.text, parsed.data.attachments)))
            return { error: t("sessions.errors.queueFull", { count: promptQueue.QUEUE_MAX }) };
        // The turn may have ended between the read and the write; then nothing
        // would ever send it, so it goes now.
        const now = await sessions.getSession(session.id, user.id);
        if (now && core.isSessionListening(now.state)) await promptQueue.deliverNextQueued(session.id);
        return { queued: true };
    }
    try {
        const sent = await promptQueue.sendPromptNow(session, user.id, parsed.data.text, parsed.data.attachments);
        if (sent.refusal) return { error: t(`sessions.errors.files.${sent.refusal}`) };
    } catch (error) {
        return { error: agentText(t, sessions.readableFailure(error, `prompting ${session.id}`)) };
    }
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
    return {};
}

const sessionModeSchema = z
    .object({ sessionId: z.string().trim().uuid(), mode: z.enum(core.SESSION_PERMISSION_MODES) })
    .strict();

/**
 * Change a running session's permission mode mid-session. Not while the agent
 * waits on an answer: in its terminal the keys that switch modes would answer
 * that prompt instead (Shift+Tab approves a plan).
 */
export async function setSessionModeAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const [t, tp] = await Promise.all([getTranslations("agents"), getTranslations("polar")]);
    const parsed = sessionModeSchema.safeParse(input);
    if (!parsed.success) return { error: t("sessions.errors.gone") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session || core.isSessionOver(session.state)) return { error: t("sessions.errors.gone") };
    if (!core.takesPermissionMode(session.cli)) return { error: tp("code.modeFailed") };
    if (session.permissionMode === parsed.data.mode) return {};
    if (await permissions.pendingPermission(session.id)) return { error: tp("code.modeBusy") };
    try {
        await runtime.changeSessionMode(session.id, session.cli, session.permissionMode, parsed.data.mode);
        await prisma.agentSession.update({
            where: { id: session.id },
            data: { permissionMode: parsed.data.mode },
            select: { id: true }
        });
    } catch (error) {
        console.error(`[agent-session] ${session.id}: mode change failed:`, error);
        return { error: tp("code.modeFailed") };
    }
    return {};
}

const sessionSurfaceSchema = z
    .object({ sessionId: z.string().trim().uuid(), surface: z.enum(acpProviders.SESSION_SURFACES) })
    .strict();

/**
 * Hold a running session's conversation in its terminal or in Chat (over the
 * Agent Client Protocol). Not mid-turn: the turn belongs to the side that
 * started it.
 */
export async function setSessionSurfaceAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const [t, tp] = await Promise.all([getTranslations("agents"), getTranslations("polar")]);
    const parsed = sessionSurfaceSchema.safeParse(input);
    if (!parsed.success) return { error: t("sessions.errors.gone") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session || core.isSessionOver(session.state)) return { error: t("sessions.errors.gone") };
    if (session.surface === parsed.data.surface) return {};
    if (parsed.data.surface === "chat" && !acpProviders.chatAvailable(session.cli, session.place))
        return { error: tp("code.surface.unavailable") };
    if (session.state === "working" || session.state === "waiting") return { error: tp("code.surface.busy") };
    try {
        await runtime.switchSessionSurface(session.id, parsed.data.surface);
    } catch (error) {
        console.error(`[agent-session] ${session.id}: surface change failed:`, error);
        return { error: tp("code.surface.failed") };
    }
    return {};
}

const sessionModelSchema = z
    .object({
        sessionId: z.string().trim().uuid(),
        // Null is the account's own default, which Claude Code calls `default`.
        model: z.string().trim().regex(core.SAFE_MODEL_ID).nullable()
    })
    .strict();

/**
 * Change a running Claude session's model mid-session, on the account it
 * already signs in with. Not while the agent waits on an answer: in an open
 * terminal the typed `/model` would answer that prompt instead.
 */
export async function setSessionModelAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const [t, tp] = await Promise.all([getTranslations("agents"), getTranslations("polar")]);
    const parsed = sessionModelSchema.safeParse(input);
    if (!parsed.success) return { error: t("sessions.errors.gone") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session || core.isSessionOver(session.state)) return { error: t("sessions.errors.gone") };
    if (!core.takesPermissionMode(session.cli)) return { error: tp("code.modelFailed") };
    const model = parsed.data.model;
    if ((session.modelChoice?.model ?? null) === model) return {};
    if (await permissions.pendingPermission(session.id)) return { error: tp("code.modelBusy") };
    try {
        await runtime.changeSessionModel(session.id, model ?? "default");
        const provider = core.agentCliById(session.cli)?.model?.provider ?? null;
        await prisma.agentSession.update({
            where: { id: session.id },
            data: model
                ? { model, modelProvider: session.modelChoice?.provider ?? provider }
                : { model: null, modelProvider: null },
            select: { id: true }
        });
    } catch (error) {
        console.error(`[agent-session] ${session.id}: model change failed:`, error);
        return { error: tp("code.modelFailed") };
    }
    return {};
}

const sessionEffortSchema = z
    .object({
        sessionId: z.string().trim().uuid(),
        effort: z.enum(core.AGENT_EFFORT_LEVELS)
    })
    .strict();

/**
 * Change how hard a running Claude session thinks, as `/effort` does. Not while
 * the agent waits on an answer, for the same reason as the model.
 */
export async function setSessionEffortAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const [t, tp] = await Promise.all([getTranslations("agents"), getTranslations("polar")]);
    const parsed = sessionEffortSchema.safeParse(input);
    if (!parsed.success) return { error: t("sessions.errors.gone") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session || core.isSessionOver(session.state)) return { error: t("sessions.errors.gone") };
    if (core.agentEffortLevels(session.cli).length === 0) return { error: tp("effort.failed") };
    if (session.effort === parsed.data.effort) return {};
    if (await permissions.pendingPermission(session.id)) return { error: tp("code.modelBusy") };
    try {
        await runtime.changeSessionEffort(session.id, session.cli, parsed.data.effort);
        await prisma.agentSession.update({
            where: { id: session.id },
            data: { effort: parsed.data.effort },
            select: { id: true }
        });
    } catch (error) {
        console.error(`[agent-session] ${session.id}: effort change failed:`, error);
        return { error: tp("effort.failed") };
    }
    return {};
}

export async function stopSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: (await getTranslations("agents"))("sessions.errors.gone") };
    // A queued session has no machine to take down: cancelling is the whole
    // stop. One that started in the meantime is stopped the ordinary way.
    if (!(await queue.cancelQueued(sessionId))) await runtime.stopSession(sessionId);
    // Whatever this freed goes to whoever is waiting, now rather than on the
    // next pass of the timer.
    after(() => queue.sweepSessionQueue().catch(() => 0));
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
    return {};
}

/** What the agent's terminal shows right now, for the panel that would rather
 *  show the last few lines than open a full terminal to every session. */
export async function sessionScreenAction(
    sessionId: string
): Promise<{ screen?: string; preparing?: computerProgress.ComputerProgress | null; error?: string }> {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const session = await sessions.getSession(sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    // A session on somebody's computer has no screen to read here; what it
    // shows while starting is the runner preparing the tools.
    if (session.place === "computer") {
        // The runner may be on another node, which publishes its progress.
        onRunnerLive(computerProgress.receiveProgressNotice);
        return { screen: "", preparing: computerProgress.computerProgress(sessionId) };
    }
    if (core.isSessionOver(session.state)) return { screen: "" };
    try {
        return { screen: await runtime.captureSession(sessionId) };
    } catch {
        return { error: t("sessions.errors.noAnswer") };
    }
}

/** Try again, for a computer whose tools could not be prepared: the runner
 *  prepares them again, keeping whatever already finished. */
export async function retryComputerToolchainAction(sessionId: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("agents");
    const id = z.string().trim().uuid().safeParse(sessionId);
    if (!id.success) return { error: t("sessions.errors.gone") };
    const user = await requirePermission("agents.manage");
    const session = await sessions.getSession(id.data, user.id);
    if (!session || session.place !== "computer" || !session.runnerId) return { error: t("sessions.errors.gone") };
    const computer = await computerFor(user.id, session.runnerId);
    if (!computer?.online) return { error: t("text.computerOffline", { name: computer?.name ?? "" }) };
    const agents = core.TOOLCHAIN_AGENTS.includes(session.cli as (typeof core.TOOLCHAIN_AGENTS)[number]) ? [session.cli] : [];
    const sent = await sendToRunner(session.runnerId, { type: "toolchain.prepare", requestId: crypto.randomUUID(), agents });
    return sent ? {} : { error: t("text.computerOffline", { name: computer.name }) };
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

const revertInputSchema = z.object({
    sessionId: sessionIdSchema,
    path: z.string().min(1).max(4096).refine(safeChangePath),
    hunk: z
        .object({
            index: z.number().int().min(0).max(100_000),
            id: z.string().regex(/^[0-9a-f]{8}$/)
        })
        .optional()
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

/** Put one changed file, or one hunk of it, back the way the branch started.
 *  Destructive: the screen asks first. */
export async function revertSessionChangeAction(
    input: unknown
): Promise<{ answer?: review.RevertAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = revertInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    return {
        answer: await review.revertSessionChange(session, { path: parsed.data.path, hunk: parsed.data.hunk })
    };
}

const stepTurnInputSchema = z.object({
    sessionId: sessionIdSchema,
    direction: z.enum(["undo", "redo"]),
    to: z.string().regex(COMMIT_PATTERN).optional()
});

/** The session's turns that can be undone, newest first. */
export async function sessionTurnsAction(
    sessionId: unknown
): Promise<{ answer?: turns.TurnsAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: t("session.turns.errors.invalid") };
    const session = await controlledSession(parsed.data);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await turns.listSessionTurns(session) };
}

/** Put the checkout back to before a turn, or forward again. Destructive for
 *  what the agent wrote since: the screen asks first. */
export async function stepSessionTurnAction(
    input: unknown
): Promise<{ answer?: turns.StepAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = stepTurnInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.turns.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await turns.stepSessionTurn(session, parsed.data) };
}

/** The files in a running session's checkout, for the workspace beside it. */
export async function sessionFilesAction(sessionId: string): Promise<{ answer?: files.FilesAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await files.listSessionFiles(session.id) };
}

/** The web servers it runs, for the preview beside a Code thread. */
export async function sessionPreviewAction(
    sessionId: string
): Promise<{ answer?: preview.PreviewPortsAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await preview.sessionPreviewPorts(session.id) };
}

/** One file of it. The path is checked again where it is read. */
export async function sessionFileAction(
    input: unknown
): Promise<{ answer?: files.FileAnswer; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = z.object({ sessionId: sessionIdSchema, path: z.string().min(1).max(1024) }).safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    return { answer: await files.readSessionFile(session.id, parsed.data.path) };
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
                sessionUrl: `${base.replace(/\/+$/, "")}${polarSession(session.id)}`,
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
    if (result.kind === "refused") {
        if (result.reason === "push")
            return { error: t(`session.work.reasons.${result.pushReason ?? "other"}`) };
        return { error: t(`session.ship.refusals.${result.reason}`) };
    }
    if (result.kind === "opened") after(() => noteIssueOfPull(session, result.pull));
    return {
        pull: {
            number: result.pull.number,
            url: result.pull.url,
            existing: result.kind === "existing"
        }
    };
}

// ---------------------------------------------------------------------------
// Resume
//
// An agent that exited leaves its window at a shell, with the session still
// alive around it. Resume types the launch line back in on the conversation its
// hooks last reported. For whoever may steer the session, like every control
// above, and only once the terminal itself says the agent is gone - typed into a
// running agent, the line would be a prompt.
// ---------------------------------------------------------------------------

const resumeInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

/** The conversation a session's agent could be reopened on, or null. */
async function resumableConversation(session: sessions.SessionView): Promise<string | null> {
    if (core.agentResumeStyle(session.cli) === "") return null;
    return sessions.sessionVendorId(session.id);
}

/** Whether the Resume button belongs on the screen right now. */
export async function sessionResumableAction(sessionId: string): Promise<{ resumable: boolean }> {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { resumable: false };
    const session = await controlledSession(parsed.data);
    if (!session || core.isSessionOver(session.state) || session.state === "starting")
        return { resumable: false };
    if (!(await resumableConversation(session))) return { resumable: false };
    return { resumable: await runtime.agentHasExited(session.id) };
}

export async function resumeSessionAction(input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("agents");
    const parsed = resumeInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    if (core.isSessionOver(session.state)) return { error: t("sessions.errors.ended") };
    const conversation = await resumableConversation(session);
    if (!conversation) return { error: t("sessions.errors.notResumable") };
    // Asked again rather than trusted from the screen: the button was drawn up to
    // a poll ago, and somebody may have started the agent by hand since.
    if (!(await runtime.agentHasExited(session.id)))
        return { error: t("sessions.errors.stillRunning") };
    try {
        await runtime.resumeAgent(session.id, conversation);
    } catch (error) {
        return { error: agentText(t, sessions.readableFailure(error, `resuming ${session.id}`)) };
    }
    return {};
}

const sessionAccountSchema = z
    .object({ sessionId: sessionIdSchema, accountId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/) })
    .strict();

export interface SessionAccountChoice {
    readonly id: string;
    readonly name: string;
    /** Until when it is at its limit or refused, ISO, or null when ready. */
    readonly coolingUntil: string | null;
}

/** The accounts a running session could move to, and the one it is on. */
export async function sessionAccountsAction(
    sessionId: string
): Promise<{ current: string | null; accounts: SessionAccountChoice[] } | null> {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return null;
    const session = await controlledSession(parsed.data);
    if (!session) return null;
    const found = await rotation.sessionAccountChoices(session.id).catch(() => null);
    if (!found) return null;
    const now = Date.now();
    return {
        current: found.current,
        accounts: found.accounts.map((account) => ({
            id: account.id,
            name: account.name,
            coolingUntil:
                account.coolingUntil && account.coolingUntil > now ? new Date(account.coolingUntil).toISOString() : null
        }))
    };
}

/**
 * Move a running session to another of its owner's accounts for its tool. The
 * next turn launches on it and resumes the same conversation; an agent that
 * left its terminal is brought back on it now, and one in its own interface
 * ends its turn and starts again on it, the turn sent again. Not while the
 * agent waits on an answer, which a restart would drop.
 */
export async function switchSessionAccountAction(input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionAccountSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.account.errors.unknown") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session || core.isSessionOver(session.state)) return { error: t("sessions.errors.gone") };
    if (await permissions.pendingPermission(session.id)) return { error: t("session.account.errors.busy") };
    try {
        const outcome = await rotation.switchSessionAccount(session.id, parsed.data.accountId, rotation.switchPorts());
        if (outcome === "moved" || outcome === "same") return {};
        if (outcome === "over") return { error: t("sessions.errors.gone") };
        if (outcome === "machine") return { error: t("session.account.errors.machine") };
        if (outcome === "raced") return { error: t("session.account.errors.raced") };
        return { error: t("session.account.errors.unknown") };
    } catch (error) {
        console.error(`[agent-session] ${session.id}: account switch failed:`, error instanceof Error ? error.message : "unknown");
        return { error: t("session.account.errors.failed") };
    }
}

/**
 * Open the agent's own interface in the session's terminal, for whoever may
 * steer it. A session whose terminal already is the interface says so.
 */
export async function openAgentInterfaceAction(
    sessionId: string
): Promise<{ outcome?: "opened" | "interactive" | "busy"; error?: string }> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data);
    if (!session) return { error: t("sessions.errors.gone") };
    if (core.isSessionOver(session.state)) return { error: t("sessions.errors.ended") };
    try {
        return { outcome: await runtime.openAgentInterface(session.id) };
    } catch (error) {
        return { error: agentText(t, sessions.readableFailure(error, `opening the interface of ${session.id}`)) };
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const historyInputSchema = z.object({
    sessionId: sessionIdSchema,
    before: z.string().trim().uuid().optional()
});

/**
 * A page of a session's conversation, for whoever may read the session - its
 * owner, or somebody it was shared with.
 *
 * Asking for the newest page first reads whatever the agent's transcript gained
 * since the last read (claimed per session, so many viewers are one read every
 * few seconds). An older page only reads what is stored.
 */
export async function sessionHistoryAction(input: unknown): Promise<{
    messages?: history.HistoryMessage[];
    older?: boolean;
    error?: string;
}> {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const parsed = historyInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.history.errors.invalid") };
    const { sessionId, before } = parsed.data;
    const session =
        (await sessions.getSession(sessionId, user.id)) ??
        (await sessions.sharedSession(sessionId, user.id));
    if (!session) return { error: t("sessions.errors.gone") };
    if (!before) await history.syncSessionHistory(sessionId);
    return history.historyPage(sessionId, { before });
}

/**
 * Answer the permission prompt a Claude session handed to Polaris: from the
 * session page, or from the buttons on a pushed notification (through the
 * route that wraps this). Only somebody who may steer the session - the same
 * check prompting it uses - and idempotent: the same answer twice is one.
 */
export async function answerPermissionAction(
    input: unknown
): Promise<{ status?: string; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = permissions.permissionAnswerSchema.safeParse(input);
    if (!parsed.success) return { error: t("sessions.errors.permissionGone") };
    const outcome = await permissions.answerPermission(
        parsed.data.requestId,
        parsed.data.choice,
        user.id,
        async (sessionId) => {
            const session = await sessions.getSession(sessionId, user.id);
            return session !== null && !core.isSessionOver(session.state);
        },
        parsed.data.answer ?? null
    );
    if (outcome.ok) return { status: outcome.status };
    return {
        error:
            outcome.reason === "answered"
                ? t("sessions.errors.permissionAnswered")
                : t("sessions.errors.permissionGone")
    };
}

// ---------------------------------------------------------------------------
// Review loop
//
// What somebody reading the diff or the pull request's checks sends back to the
// agent, and merging the pull request once it is right. Every one of these is
// for whoever may steer the session, like the controls above.
// ---------------------------------------------------------------------------

/** Type a prompt into a live session and keep it in its conversation. */
async function sendToAgent(
    session: sessions.SessionView,
    userId: string,
    text: string
): Promise<{ error?: string }> {
    const t = await getTranslations("agents");
    if (core.isSessionOver(session.state)) return { error: t("sessions.errors.ended") };
    await sessions.addSessionMessage(session.id, "user", text, userId);
    try {
        await runtime.promptSession(session.id, text);
    } catch (error) {
        return { error: agentText(t, sessions.readableFailure(error, `prompting ${session.id}`)) };
    }
    return {};
}

const reviewInputSchema = z
    .object({
        sessionId: sessionIdSchema,
        comments: z
            .array(
                z
                    .object({
                        path: z.string().trim().min(1).max(1024),
                        line: z.number().int().positive().max(10_000_000),
                        side: z.enum(["new", "old"]),
                        code: z.string().max(2000),
                        body: z.string().trim().min(1).max(4000)
                    })
                    .strict()
            )
            .min(1)
            .max(100)
    })
    .strict();

/** Every comment left on the diff, sent to the agent as one prompt. */
export async function sendReviewCommentsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = reviewInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.review.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!parsed.data.comments.every((comment) => safeChangePath(comment.path)))
        return { error: t("session.review.errors.invalid") };
    const text = loop.reviewPrompt(parsed.data.comments, {
        intro: t("session.review.promptIntro"),
        line: (line) => t("session.review.promptLine", { line }),
        removedLine: (line) => t("session.review.promptRemoved", { line })
    });
    if (!text) return { error: t("session.review.errors.invalid") };
    return sendToAgent(session, user.id, text.slice(0, 20_000));
}

export interface SessionChecksView {
    checks: { name: string; state: "passed" | "failed" | "pending"; url: string | null }[];
    tally: { passed: number; failed: number; pending: number };
    mergeableState: string;
    pullState: "open" | "closed" | "merged" | null;
    canMerge: boolean;
    /** Whether failing checks, review comments and conflicts go to the agent unasked. */
    autoFeedback: boolean;
    /** Why merge is not offered, or null when it is. */
    mergeBlock: review.MergeBlock | null;
}

/** The token a merge or a checks read is made with (see `pullRequestToken`). */
const pullToken = review.pullRequestToken;

/** The session's pull request's checks, as GitHub reports them now. */
export async function sessionChecksAction(
    input: unknown
): Promise<{ view?: SessionChecksView | null; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await sessions.getSession(parsed.data, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.pullRequest || !session.repoFullName) return { view: null };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await pullToken(user.id, owner);
    const [found, pull, push, auto] = await Promise.all([
        pullRequestChecks(owner, repo, session.pullRequest.number, token),
        review.linkedPullRequest(session).catch(() => null),
        review.sessionPushSetting(session.id),
        prisma.agentSession.findUnique({ where: { id: session.id }, select: { autoFeedback: true } })
    ]);
    if (!found) return { error: t("session.checks.unreachable") };
    const block = review.mergeBlock({
        state: pull?.state ?? null,
        draft: pull?.draft ?? false,
        mergeState: found.mergeableState,
        push
    });
    return {
        view: {
            checks: found.checks.map((check) => ({
                name: check.name,
                state:
                    check.status !== "completed"
                        ? "pending"
                        : loop.checkFailed(check)
                          ? "failed"
                          : "passed",
                url: check.url
            })),
            tally: loop.checksTally(found.checks),
            mergeableState: found.mergeableState,
            pullState: pull?.state ?? null,
            canMerge: block === null,
            mergeBlock: block,
            autoFeedback: auto?.autoFeedback ?? true
        }
    };
}

const autoFeedbackSchema = z.object({ sessionId: sessionIdSchema, on: z.boolean() }).strict();

/** Turn the session's automatic feedback (session-feedback.ts) on or off. */
export async function setSessionAutoFeedbackAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = autoFeedbackSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    await prisma.agentSession.update({ where: { id: session.id }, data: { autoFeedback: parsed.data.on } });
    return {};
}

/** The failing checks, with what each said about itself, sent to the agent. */
export async function sendFailingChecksAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await sessions.getSession(parsed.data, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.pullRequest || !session.repoFullName)
        return { error: t("session.checks.noPull") };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const found = await pullRequestChecks(
        owner,
        repo,
        session.pullRequest.number,
        await pullToken(user.id, owner)
    );
    if (!found) return { error: t("session.checks.unreachable") };
    const text = loop.failingChecksPrompt(found.checks, {
        intro: t("session.checks.promptIntro", { number: session.pullRequest.number }),
        noSummary: t("session.checks.promptNoSummary")
    });
    if (!text) return { error: t("session.checks.noneFailing") };
    return sendToAgent(session, user.id, text);
}

const mergeInputSchema = z
    .object({
        sessionId: sessionIdSchema,
        method: z.enum(["merge", "squash", "rebase"]),
        /** The head commit the person saw: GitHub refuses the merge if the
         *  branch moved since, instead of merging commits nobody reviewed. */
        sha: z
            .string()
            .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/i)
            .optional()
    })
    .strict();

/** Merge the session's pull request on GitHub. Branch protection, required
 *  checks and the person's own permission are GitHub's to enforce; its answer
 *  is what the page shows when it says no. */
export async function mergeSessionPullAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = mergeInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.merge.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.pullRequest || !session.repoFullName)
        return { error: t("session.checks.noPull") };
    if ((await review.sessionPushSetting(session.id)) === "disabled")
        return { error: t("session.ship.refusals.readOnly") };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await pullToken(user.id, owner);
    if (!token) return { error: t("session.ship.refusals.noAuth") };
    const result = await mergePullRequest(
        owner,
        repo,
        session.pullRequest.number,
        { method: parsed.data.method, sha: parsed.data.sha },
        token
    );
    timelines.forgetTimeline(session.id);
    if (result.ok) return {};
    const said = result.message
        ? ` ${t("session.merge.githubSaid", { message: result.message })}`
        : "";
    return { error: `${t(`session.merge.errors.${result.reason}`)}${said}` };
}
// ---------------------------------------------------------------------------
// The pull request tab
//
// Checks, reviews, comments and commits read from GitHub on demand (and kept a
// few seconds), a reply to a comment, and claiming a pull request that already
// exists. Only whoever may steer the session reaches any of them, and every
// write is made with the person's own GitHub account when they linked one, so
// GitHub holds them to their own permissions on the repository.
// ---------------------------------------------------------------------------

export interface SessionPullTabView {
    timeline: timelines.PullTimeline;
    mergeBlock: review.MergeBlock | null;
    /** Whether the reply boxes are offered: never on a merged or closed one. */
    canReply: boolean;
}

const pullTabInputSchema = z
    .object({ sessionId: sessionIdSchema, fresh: z.boolean().optional() })
    .strict();

/** The session's pull request as its tab shows it, or `view: null` when the
 *  session links none yet. */
export async function sessionPullTabAction(
    input: unknown
): Promise<{ view?: SessionPullTabView | null; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = pullTabInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.pr.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    const [answer, push] = await Promise.all([
        review.sessionPullTimeline(session, user.id, { fresh: parsed.data.fresh }),
        review.sessionPushSetting(session.id)
    ]);
    if (answer.kind === "none") return { view: null };
    if (answer.kind === "noAuth") return { error: t("session.ship.refusals.noAuth") };
    if (answer.kind === "unreachable") return { error: t("session.pr.errors.unreachable") };
    const { timeline } = answer;
    return {
        view: {
            timeline,
            mergeBlock: review.mergeBlock({
                state: timeline.state,
                draft: timeline.draft,
                mergeState: timeline.mergeState,
                push
            }),
            canReply: timeline.state === "open"
        }
    };
}

const replyInputSchema = z
    .object({
        sessionId: sessionIdSchema,
        body: z.string().trim().min(1).max(timelines.BODY_MAX),
        threadId: z
            .string()
            .regex(/^[A-Za-z0-9_=-]{1,200}$/)
            .optional()
    })
    .strict();

/** A reply in a review thread, or a comment on the conversation. */
export async function replySessionPullAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = replyInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.pr.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    const result = await review.replyOnSessionPull(session, user.id, {
        body: parsed.data.body,
        threadId: parsed.data.threadId
    });
    if (result.ok) return {};
    if (result.reason === "noPull") return { error: t("session.checks.noPull") };
    if (result.reason === "noAuth") return { error: t("session.ship.refusals.noAuth") };
    const said = result.message ? ` ${t("session.merge.githubSaid", { message: result.message })}` : "";
    return { error: `${t(`session.pr.replyErrors.${result.reason}`)}${said}` };
}

const claimInputSchema = z
    .object({
        sessionId: sessionIdSchema,
        ref: z.string().trim().min(1).max(500),
        takeover: z.boolean().optional()
    })
    .strict();

/** Attach a pull request that already exists to the session. */
export async function claimSessionPullAction(
    input: unknown
): Promise<{ pull?: { number: number; url: string }; refusal?: review.ClaimRefusal; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = claimInputSchema.safeParse(input);
    if (!parsed.success) return { refusal: "invalid", error: t("session.pr.claim.refusals.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    const result = await review.claimSessionPullRequest(
        session,
        parsed.data.ref,
        { takeover: parsed.data.takeover === true },
        review.claimDeps(user.id)
    );
    if (result.kind === "refused")
        return { refusal: result.reason, error: t(`session.pr.claim.refusals.${result.reason}`) };
    return { pull: { number: result.pull.number, url: result.pull.url } };
}

// ---------------------------------------------------------------------------
// Reviewer agent (session-reviewer.ts)
// ---------------------------------------------------------------------------

/** How many passes the tab lists, newest first. */
const REVIEWS_SHOWN = 5;

export interface SessionReviewerView {
    /** The tools that can review, for the picker. */
    options: { id: string; label: string }[];
    cli: string | null;
    model: string | null;
    /** Whether this reader may change the repository's reviewer: its owner only. */
    canEdit: boolean;
    reviews: {
        id: string;
        headSha: string;
        attempt: number;
        trigger: string;
        cli: string;
        state: string;
        verdict: string | null;
        summary: string | null;
        findings: reviewer.ReviewFinding[];
        error: string | null;
        fedBack: boolean;
        startedAt: string;
    }[];
}

/** The repository's reviewer and the latest passes over this session's pull request. */
export async function sessionReviewerAction(
    input: unknown
): Promise<{ view?: SessionReviewerView | null; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await sessions.getSession(parsed.data, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.repoId) return { view: null };
    const [repo, rows] = await Promise.all([
        prisma.agentRepo.findUnique({
            where: { id: session.repoId },
            select: { ownerId: true, sessionReviewer: true, sessionReviewerModel: true }
        }),
        session.pullRequest
            ? prisma.sessionReview.findMany({
                  where: { sessionId: session.id, number: session.pullRequest.number },
                  orderBy: { startedAt: "desc" },
                  take: REVIEWS_SHOWN,
                  select: {
                      id: true,
                      headSha: true,
                      attempt: true,
                      trigger: true,
                      cli: true,
                      state: true,
                      verdict: true,
                      summary: true,
                      findings: true,
                      error: true,
                      fedBack: true,
                      startedAt: true
                  }
              })
            : Promise.resolve([])
    ]);
    if (!repo) return { view: null };
    return {
        view: {
            options: reviewer.reviewerClis().map((cli) => ({ id: cli.id, label: cli.label })),
            cli: reviewer.reviewerCli(repo.sessionReviewer)?.id ?? null,
            model: repo.sessionReviewerModel,
            canEdit: repo.ownerId === user.id,
            reviews: rows.map((row) => ({
                ...row,
                findings: reviewer.readFindings(row.findings),
                startedAt: row.startedAt.toISOString()
            }))
        }
    };
}

const reviewerSettingsSchema = z
    .object({
        sessionId: sessionIdSchema,
        cli: z.string().trim().max(64).nullable(),
        model: z
            .string()
            .trim()
            .max(200)
            .nullable()
            .transform((value) => (value ? value : null))
            .refine((value) => value === null || core.SAFE_MODEL_ID.test(value))
    })
    .strict();

/** Pick the repository's reviewer tool and model; a null tool turns it off. */
export async function setSessionReviewerAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = reviewerSettingsSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.reviewer.errors.invalid") };
    const cli = parsed.data.cli ? reviewer.reviewerCli(parsed.data.cli) : null;
    if (parsed.data.cli && !cli) return { error: t("session.reviewer.errors.invalid") };
    const session = await sessions.getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.repoId) return { error: t("session.reviewer.errors.noRepo") };
    const updated = await prisma.agentRepo.updateMany({
        where: { id: session.repoId, ownerId: user.id },
        data: { sessionReviewer: cli?.id ?? null, sessionReviewerModel: cli ? parsed.data.model : null }
    });
    if (updated.count === 0) return { error: t("session.reviewer.errors.notOwner") };
    return {};
}

/** Review the pull request's current head now, whatever the last pass said. */
export async function requestSessionReviewAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await sessions.getSession(parsed.data, user.id);
    if (!session) return { error: t("sessions.errors.gone") };
    if (!session.pullRequest) return { error: t("session.checks.noPull") };
    const outcome = await requestReview({ sessionId: session.id, number: session.pullRequest.number, trigger: "manual" });
    if (outcome.started) return {};
    const known = ["missing_reviewer", "review_running", "terminated", "no_pr", "closed_pr", "merged_pr", "start_failed"] as const;
    const reason = known.find((one) => one === outcome.reason) ?? "other";
    return { error: t(`session.reviewer.refused.${reason}`) };
}

/**
 * A session's deliverables as stored, after capturing what changed when
 * `capture` is set. The list answers either way: a capture that cannot reach
 * the container leaves what was captured before.
 */
export async function sessionArtifactsAction(input: unknown): Promise<{
    artifacts?: artifacts.ArtifactView[];
    capture?: artifacts.CaptureAnswer;
    error?: string;
}> {
    const t = await getTranslations("agents");
    const parsed = z.object({ sessionId: sessionIdSchema, capture: z.boolean().default(false) }).safeParse(input);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const session = await controlledSession(parsed.data.sessionId);
    if (!session) return { error: t("sessions.errors.gone") };
    const capture = parsed.data.capture ? await artifacts.captureSessionArtifacts(session.id) : undefined;
    return { artifacts: await artifacts.listSessionArtifacts(session.id), capture };
}

/** One artifact and its versions, for whoever may read it. */
export async function sessionArtifactAction(artifactId: unknown): Promise<{
    detail?: { artifact: artifacts.ArtifactView; versions: artifacts.ArtifactVersionView[] };
    error?: string;
}> {
    const t = await getTranslations("agents");
    const parsed = sessionIdSchema.safeParse(artifactId);
    if (!parsed.success) return { error: t("session.changes.errors.invalid") };
    const user = await requireUser();
    if (!(await artifacts.mayReadArtifact(user.id, parsed.data))) return { error: t("sessions.errors.gone") };
    const detail = await artifacts.artifactDetail(parsed.data);
    if (!detail) return { error: t("sessions.errors.gone") };
    return { detail: { artifact: detail.artifact, versions: detail.versions } };
}
