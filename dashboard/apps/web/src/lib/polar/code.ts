/**
 * Polar's Code side: the person's agent sessions, read for the sidebar, and
 * the start and reply that go with them. Asked through `/api/polar/code/*`.
 *
 * Code work in Polar is an Agents session - the harness, the repository, the
 * branch - and never an answer from the chat model. So everything here is the
 * Agents app's own actions, asked only once this account is known to hold the
 * permission: those actions send somebody without it to another page, which a
 * panel open beside some other screen must never do.
 *
 * The labels are translated here rather than in the browser so the panel does
 * not have to carry the whole Agents catalog onto every page.
 */

import * as core from "@polaris/core";
import { repoAgentFiles, type RepoAgentFile } from "@/lib/polar/agents/repo-agents";
import { z } from "zod";
import { getTranslations } from "@/lib/i18n/request";
import { GOAL_CONDITION_MAX, readGoal, type PolarGoal } from "@/lib/polar/goals";
import { clearSessionGoal, setSessionGoal } from "@/lib/agents/session-goal";
import { prisma } from "@polaris/db";
import * as acpProviders from "@/lib/agents/acp/providers";
import { polarCredentialFor } from "@/lib/polar/access";
import {
    githubApiToken,
    githubAppInstallationToken,
    githubAppInstallUrl,
    listOpenIssues,
    listRepoBranches,
    readIssue,
    repoDefaultBranch,
    type RepoIssue
} from "@/lib/github-service";
import { agentSkills, listSkills } from "@/lib/polar/skills/store";
import { agentFor } from "@/lib/polar/agents/store";
import { agentTaskPrompt } from "@/lib/polar/agents/shared";
import type { PermissionRule } from "@/lib/polar/agents/permissions";
import { codeComposerFor, type CodeComposer } from "@/lib/polar/agents/composer-agents";
import { resolvedStart } from "@/lib/polar/agents/resolve-start";
import { liveSourceFor } from "@/lib/polar/agents/code-sources";
import { listComputers } from "@/lib/computers/computer-service";
import { placeOf } from "@/lib/polar/code-place";
import { codeStartersSchema, starterPrompt, type StarterSkill } from "@/lib/polar/code-starters";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { userHasManage, type SessionUser } from "@/lib/session";
import { sessionCursor } from "@/lib/agents/session-cursor";
import { priceSlugs, storedContextParts, type ContextParts } from "@/lib/agents/session-usage";
import * as promptQueue from "@/lib/agents/session-prompt-queue";
import * as transcript from "@/lib/polar/code-transcript";
import { getCatalogModel } from "@/lib/agents/model-catalog";
import {
    dedupeCodeRows,
    POLAR_CODE_PAGE,
    polarCodeEditSchema,
    polarCodeInterruptSchema,
    polarCodeQueueSchema,
    polarCodeSubagentSchema,
    threadEvents
} from "@/lib/polar/code-history";
import { agentText, SESSION_EVENT_KEYS, sessionStateWord } from "@/lib/agents/words";
import { lastChangeAt, lastToolAt, shownSessionBranch } from "@/lib/agents/session-branch";
import * as repoOptions from "@/lib/agents/repo-options";
import {
    getSession,
    hideSessionFromPolar,
    renameSession,
    sessionSubagentEvents,
    subagentTranscriptRef,
    type SessionView
} from "@/lib/agents/session-service";
import { subagentTreeFromEvents, type SubagentNode } from "@/lib/agents/session-subagents";
import { readSubagentTranscript, type SubagentTranscriptAnswer } from "@/lib/agents/session-files";
import { keepSpare } from "@/lib/agents/session-spares";
import { queuePosition } from "@/lib/agents/session-queue";
import { capacityRefusal, sessionCapacity } from "@/lib/agents/session-capacity";
import { pendingPermission, type PendingPermission } from "@/lib/agents/session-permissions";
import { storedTodos, type SessionTodo } from "@/lib/agents/session-asks";
import { lastTurnRefused, refusedAccountName } from "@/lib/agents/signin-refusal";
import {
    forkSessionAction,
    interruptSessionAction,
    listSessionsAction,
    promptSessionAction,
    setSessionModeAction,
    setSessionSurfaceAction,
    setSessionEffortAction,
    sessionAccountsAction,
    switchSessionAccountAction,
    setSessionModelAction,
    sessionChoicesAction,
    sessionDetailAction,
    startSessionAction,
    stopSessionAction
} from "@/components/agents/sessions/actions";

/** What this account may do on the Code side: nothing, read sessions, or start them. */
export type PolarCodeAccess = "none" | "read" | "manage";

export interface PolarCodeRow {
    readonly id: string;
    readonly title: string;
    /** `owner/name`, or empty for a workspace with nothing checked out. */
    readonly repo: string;
    readonly branch: string;
    readonly state: core.AgentSessionState;
    readonly stateLabel: string;
    /** Whether it can still be told something. */
    readonly live: boolean;
    readonly createdAt: string;
}

export interface PolarCodeOverview {
    readonly access: PolarCodeAccess;
    /** A page of the person's own sessions, newest first, each task once. */
    readonly sessions: readonly PolarCodeRow[];
    /** Where the next page starts, or null on the last one. */
    readonly next: string | null;
}

export interface PolarCodeEntry {
    readonly at: string;
    /** A message somebody said, or a line of what the agent did. */
    readonly type: "message" | "event";
    readonly role: string;
    readonly text: string;
    readonly detail: string;
}

export interface PolarCodeThread {
    readonly session: PolarCodeRow;
    readonly entries: readonly PolarCodeEntry[];
    readonly error: string | null;
    /** The session as the Agents app has it, for the workspace beside the
     *  thread - its changes and its terminal read from this. */
    readonly view: SessionView;
    /** Whether this reader may steer it: the terminal and the files are only
     *  offered to somebody who could start a session. */
    readonly canManage: boolean;
    /** The agent's question waiting on an answer, for somebody who may steer
     *  the session; null when nothing is waiting. */
    readonly permission: PendingPermission | null;
    /** How full the agent's context is, as its last turn reported it; null
     *  when no turn was read or the model's window is not known. `used` is
     *  the input side (fresh, cache reads, cache writes), the way Claude
     *  Code's own `used_percentage` counts it; `parts` splits the turn as the
     *  transcript reports it, null for a session read before it was kept. */
    readonly context: {
        readonly used: number;
        readonly window: number;
        readonly parts: ContextParts | null;
    } | null;
    /** The model the agent's last turn ran on, as its transcript names it;
     *  null before a turn was read. */
    readonly model: string | null;
    /** Messages typed mid-turn, waiting for it to end, oldest first. Only for
     *  somebody who may steer it; empty otherwise. */
    readonly waiting: readonly promptQueue.QueuedPrompt[];
    /** The latest turn failed because the provider refused the account the
     *  agent signs in with: what to call that account (null when the session
     *  picked none). Only for somebody who may steer it; null otherwise. */
    readonly refusedSignIn: { readonly account: string | null } | null;
    /** Why a session that has not started is still waiting, and where it stands:
     *  the screen says so, with a Cancel, instead of a bare "Queued". Only for
     *  somebody who may steer it; null for a session that is not queued. */
    readonly queued: { readonly reason: string | null; readonly position: number | null } | null;
    /** The agent's todo list as it last wrote it; empty when it keeps none. */
    readonly todos: readonly SessionTodo[];
    /** The subagents its agent launched, oldest first, each with its steps;
     *  empty when it ran none or the tool does not report them. */
    readonly subagents: readonly PolarCodeSubagent[];
    /** The session's `/goal`, as last judged; null when it has none. */
    readonly goal: PolarGoal | null;
    /** When the agent last finished writing into its checkout, or null: the
     *  workspace re-reads its diffs and reloads its preview when this moves. */
    readonly lastEdit?: string | null;
    /** When the agent last finished any other tool, or null: the workspace
     *  looks at the checkout then, for writes a shell command made. */
    readonly lastTool?: string | null;
}

/** A subagent as the thread shows it. Without its transcript path, which names
 *  a folder on the agent's machine and is not shown anywhere. */
export type PolarCodeSubagent = Omit<SubagentNode, "transcriptPath">;

/** The session's subagent tree, or none when it cannot be read: a missing
 *  tree is never a reason to fail the thread. */
async function subagentsOf(sessionId: string): Promise<PolarCodeSubagent[]> {
    try {
        return subagentTreeFromEvents(await sessionSubagentEvents(sessionId)).map(
            ({ transcriptPath: _path, ...node }) => node
        );
    } catch (error) {
        console.error(`polar: could not read the subagents of ${sessionId}`, error);
        return [];
    }
}

async function todosOf(sessionId: string): Promise<{ todos: SessionTodo[]; goal: PolarGoal | null }> {
    const row = await prisma.agentSession
        .findUnique({ where: { id: sessionId }, select: { todos: true, goal: true } })
        .catch(() => null);
    return { todos: storedTodos(row?.todos), goal: readGoal(row?.goal) };
}

/** The session's last reported size against its model's window (null when
 *  either is unknown), and the model that turn ran on. */
async function contextOf(
    sessionId: string
): Promise<{ context: PolarCodeThread["context"]; model: string | null }> {
    const row = await prisma.agentSession
        .findUnique({
            where: { id: sessionId },
            select: { contextTokens: true, contextModel: true, contextUsage: true }
        })
        .catch(() => null);
    const model = row?.contextModel || null;
    if (!row?.contextTokens || !model) return { context: null, model };
    const parts = storedContextParts(row.contextUsage);
    const used = parts ? parts.input + parts.cacheRead + parts.cacheWrite : row.contextTokens;
    for (const slug of priceSlugs(model)) {
        const found = await getCatalogModel(slug).catch(() => null);
        if (found && found.contextTokens > 0)
            return { context: { used, window: found.contextTokens, parts }, model };
    }
    return { context: null, model };
}

async function accessOf(user: SessionUser): Promise<PolarCodeAccess> {
    if (await userHasManage(user, "agents.manage")) return "manage";
    if (await userHasManage(user, "agents.read")) return "read";
    return "none";
}

function rowOf(
    t: NamespaceTranslator<"agents">,
    session: Parameters<typeof shownSessionBranch>[0] & {
        id: string;
        title: string;
        state: core.AgentSessionState;
        lastEventAt: string | null;
        createdAt: string;
    },
    events: Parameters<typeof shownSessionBranch>[1] = []
): PolarCodeRow {
    return {
        id: session.id,
        title: session.title,
        repo: session.repoFullName,
        // None without a repository, and none until the session changed
        // something: a session that only talked has no branch worth naming.
        branch: shownSessionBranch(session, events),
        state: session.state,
        stateLabel: sessionStateWord(t, session.state, session.lastEventAt !== null),
        live: !core.isSessionOver(session.state),
        createdAt: session.createdAt
    };
}

/**
 * Whether Code is open to this account, and a page of its history when it is:
 * the sessions this person started, never every session on the repositories
 * they own. `after` is the `next` of the page before.
 */
export async function polarCodeOverview(
    user: SessionUser,
    after: string | null = null
): Promise<PolarCodeOverview> {
    const access = await accessOf(user);
    if (access === "none") return { access, sessions: [], next: null };
    // One more than a page, to know whether there is another.
    const [list, t] = await Promise.all([
        listSessionsAction(POLAR_CODE_PAGE + 1, {
            mine: true,
            polar: true,
            ...(after ? { after } : {})
        }),
        getTranslations("agents")
    ]);
    const page = list.slice(0, POLAR_CODE_PAGE);
    const last = page.at(-1);
    return {
        access,
        sessions: dedupeCodeRows(page.map((session) => rowOf(t, session))),
        // The last session read, not the last one listed: a repeat dropped from
        // the page must not be read again on the next.
        next: list.length > POLAR_CODE_PAGE && last ? sessionCursor(last) : null
    };
}

/** Why a session ended, in words, from the reason its tool reported. */
function endReason(t: NamespaceTranslator<"agents">, reason: string): string {
    if (reason === "prompt_input_exit") return t("session.events.endReason.prompt_input_exit");
    if (reason === "logout") return t("session.events.endReason.logout");
    return reason ? t("session.events.endReason.other") : "";
}

/** Why a queued session waits - the ceiling that is full, in the person's words -
 *  and where it stands in their queue. Read live, so it follows what frees. */
async function queuedReason(
    t: NamespaceTranslator<"agents">,
    userId: string,
    sessionId: string
): Promise<NonNullable<PolarCodeThread["queued"]>> {
    const [refusal, position] = await Promise.all([
        sessionCapacity(userId).then(capacityRefusal).catch(() => null),
        queuePosition(sessionId).catch(() => null)
    ]);
    return { reason: refusal ? agentText(t, refusal) : null, position };
}

/** One session as the thread shows it, or null when it is not this account's. */
export async function polarCodeThread(
    user: SessionUser,
    sessionId: string
): Promise<PolarCodeThread | null> {
    const access = await accessOf(user);
    if (access === "none") return null;
    const [detail, t, { context, model }, { todos, goal }, subagents] = await Promise.all([
        sessionDetailAction(sessionId),
        getTranslations("agents"),
        contextOf(sessionId),
        todosOf(sessionId),
        subagentsOf(sessionId)
    ]);
    if (!detail) return null;
    // Only for whoever the answer route takes it from: the person who started
    // the session, while it runs. Somebody it was shared with reads, not steers.
    const asked =
        access === "manage" && !core.isSessionOver(detail.session.state)
            ? await pendingPermission(sessionId)
            : null;
    const permission = asked && (await getSession(sessionId, user.id)) ? asked : null;
    const messages: PolarCodeEntry[] = detail.messages.map((message) => ({
        at: message.at,
        type: "message",
        role: message.role,
        // Polaris's own lines (an account switch, a resend) in the reader's words.
        text: message.role === "system" ? agentText(t, message.body) : message.body,
        detail: ""
    }));
    const events: PolarCodeEntry[] = threadEvents(detail.events).map((event) => {
        const key = SESSION_EVENT_KEYS[event.kind];
        return {
            at: event.at,
            type: "event",
            role: event.kind,
            text: key ? t(key) : event.kind,
            detail:
                event.kind === "session.end"
                    ? endReason(t, event.detail)
                    : event.kind === "prompt" && event.subject
                      ? // The account the turn ran on.
                        t("session.events.onAccount", { detail: event.detail, account: event.subject })
                      : event.detail
                        ? agentText(t, event.detail)
                        : event.subject
        };
    });
    // Stable on equal times, so a prompt and the event it caused keep the order
    // they were written in.
    const entries = [...messages, ...events].sort((a, b) => a.at.localeCompare(b.at));
    return {
        session: rowOf(t, detail.session, detail.events),
        entries,
        error: detail.session.error ? agentText(t, detail.session.error) : null,
        view: detail.session,
        canManage: access === "manage",
        permission,
        context,
        model,
        waiting:
            access === "manage" && !core.isSessionOver(detail.session.state)
                ? await promptQueue.listQueuedPrompts(sessionId).catch(() => [])
                : [],
        refusedSignIn:
            access === "manage" && lastTurnRefused(detail.events)
                ? { account: await refusedAccountName(detail.session.accountId) }
                : null,
        queued:
            access === "manage" && core.isSessionQueued(detail.session.state)
                ? await queuedReason(t, user.id, sessionId)
                : null,
        todos,
        subagents,
        goal,
        lastEdit: lastChangeAt(detail.events),
        lastTool: lastToolAt(detail.events)
    };
}

export type PolarCodeChoices = Awaited<ReturnType<typeof sessionChoicesAction>> & {
    /** GitHub's page for installing Polaris's App on more repositories, or null
     *  where no App is set up (a token connection, or none). */
    readonly installUrl: string | null;
    /** The person's Polar skills a task can start with, by name. */
    readonly skills: readonly { name: string; description: string }[];
    /** The person's sources and their models, and their own agents as
     *  personas (`composer-agents.ts`). Never a tool's name. */
    readonly code: CodeComposer;
};

/** What the composer offers - repositories and agents - or null for somebody
 *  who cannot start a session. */
export async function polarCodeChoices(user: SessionUser): Promise<PolarCodeChoices | null> {
    if ((await accessOf(user)) !== "manage") return null;
    const [choices, installUrl, skills] = await Promise.all([
        sessionChoicesAction(),
        // Unknown is no button rather than no choices.
        githubAppInstallUrl().catch(() => null),
        listSkills(user.id).catch(() => [])
    ]);
    const code = await codeComposerFor(user.id, choices.agents).catch(
        (error: unknown): CodeComposer => {
            console.error("polar: could not list the composer's sources", error);
            return { sources: [], personas: [], polarPolicy: { models: [], modelPolicy: "preferred" } };
        }
    );
    return {
        ...choices,
        installUrl,
        skills: skills.map(({ name, description }) => ({ name, description })),
        code
    };
}

/** A place the composer's picker offers besides Polaris: a paired computer
 *  (through its runner) or one of the person's own servers. */
export interface PolarCodeComputer {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    /** Absent on an answer from before servers were listed: a computer. */
    readonly kind?: "computer" | "server";
}

/** How many of the person's servers the picker lists. */
const PICKER_SERVERS = 50;

/** The person's own computers a session can be placed on. Empty for somebody
 *  who could not start a session anyway. */
export async function polarCodeComputers(user: SessionUser): Promise<PolarCodeComputer[]> {
    if ((await accessOf(user)) !== "manage") return [];
    const [computers, servers] = await Promise.all([
        listComputers(user.id),
        prisma.host.findMany({
            where: { ownerId: user.id },
            select: { id: true, name: true, status: true, offlineSince: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: PICKER_SERVERS
        })
    ]);
    return [
        ...computers.map(({ id, name, online }) => ({ id, name, online, kind: "computer" as const })),
        ...servers.map((host) => ({
            id: host.id,
            name: host.name,
            online: host.status === "active" && host.offlineSince === null,
            kind: "server" as const
        }))
    ];
}

/** Where a continued session runs, when the person moved it. */
const continueSchema = z.object({
    sessionId: z.string(),
    target: z
        .object({ kind: z.enum(["polaris", "computer", "server"]), id: z.string().uuid().nullable() })
        .refine((target) => (target.kind === "polaris") === (target.id === null))
        .optional()
});

/**
 * The prompt a task on one of the person's own agents starts with: its
 * instructions in front of what was typed, so a coding tool that has no
 * place for a system prompt still works the way the agent was set up to.
 * Null when there is no agent; an error when it is gone or runs on another
 * tool than the one asked for.
 */
async function promptWithAgent(
    user: SessionUser,
    input: unknown,
    prompt: string
): Promise<{ prompt: string; rules: PermissionRule[] } | { error: string } | null> {
    const body = input as { agentId?: unknown; cli?: unknown } | null;
    if (body?.agentId === undefined || body.agentId === null) return null;
    const agent = typeof body.agentId === "string" ? await agentFor(user.id, body.agentId) : null;
    // An agent is a persona over whatever model was picked: its instructions
    // lead the task on any engine.
    if (!agent) {
        return { error: (await getTranslations("polar"))("code.agentGone") };
    }
    return { prompt: agentTaskPrompt(agent, prompt), rules: agent.permission };
}

/** A page of the person's connected repositories for the composer's repository
 *  menu - searched, continued, or read back by id - or null for somebody who
 *  cannot start a session. */
export async function polarCodeRepos(
    user: SessionUser,
    request: repoOptions.RepoOptionsRequest
): Promise<{ items: repoOptions.RepoOption[]; next: string | null } | null> {
    if ((await accessOf(user)) !== "manage") return null;
    return repoOptions.repoOptionsPage(user.id, request);
}

/** A repository's branches for the composer's branch chip. */
export interface PolarCodeBranches {
    /** Null when GitHub would not say which one it is. */
    readonly defaultBranch: string | null;
    /** The default branch first, then the rest by name. */
    readonly branches: readonly string[];
}

/**
 * The branches of one of the person's connected repositories, read with the
 * GitHub App's installation (or the connected token when there is no App).
 * Null for a repository that is not theirs or not enabled, or when GitHub
 * would not list them.
 */
export async function polarCodeBranches(
    user: SessionUser,
    repoId: string
): Promise<PolarCodeBranches | null> {
    if ((await accessOf(user)) !== "manage") return null;
    const reach = await repoReach(user.id, repoId);
    if (!reach) return null;
    const { owner, name, token } = reach;
    const [defaultBranch, listed] = await Promise.all([
        repoDefaultBranch(owner, name, token),
        listRepoBranches(owner, name, token)
    ]);
    if (listed === null) return null;
    return { defaultBranch, branches: orderBranches(listed, defaultBranch) };
}

/**
 * The agent files of one of the person's connected repositories, on its
 * default branch (`repo-agents.ts`). Null where the repository is not theirs.
 */
export async function polarCodeRepoAgentFiles(
    user: SessionUser,
    repoId: string
): Promise<RepoAgentFile[] | null> {
    if ((await accessOf(user)) !== "manage") return null;
    const reach = await repoReach(user.id, repoId);
    return reach ? repoAgentFiles(reach, null) : null;
}

/**
 * One of the person's enabled repositories and how to read it on GitHub: the
 * App's installation, or the connected token where there is no App. Null for
 * a repository that is not theirs or not enabled.
 */
async function repoReach(
    userId: string,
    repoId: string
): Promise<{ owner: string; name: string; fullName: string; token: string | null } | null> {
    const repo = await prisma.agentRepo.findFirst({
        where: { id: repoId, ownerId: userId, enabled: true },
        select: { repoFullName: true }
    });
    if (!repo) return null;
    const [owner, name] = repo.repoFullName.split("/");
    if (!owner || !name) return null;
    const token =
        (await githubAppInstallationToken(owner).catch(() => null)) ??
        (await githubApiToken(owner).catch(() => null));
    return { owner, name, fullName: repo.repoFullName, token };
}

/**
 * The open issues of one of the person's repositories for the composer's issue
 * chip - the recent ones, or those GitHub finds for `query`. Null where the
 * repository is not theirs or GitHub would not list them.
 */
export async function polarCodeIssues(
    user: SessionUser,
    repoId: string,
    query: string
): Promise<{ items: readonly RepoIssue[] } | null> {
    if ((await accessOf(user)) !== "manage") return null;
    const reach = await repoReach(user.id, repoId);
    if (!reach) return null;
    const items = await listOpenIssues(reach.owner, reach.name, reach.token, query);
    return items ? { items } : null;
}

/**
 * The first prompt with the issue and skill the composer named folded in, read
 * here rather than taken from the browser. A string for the prompt, or the
 * sentence that says why it could not be built.
 */
async function promptWithStarters(
    user: SessionUser,
    input: unknown
): Promise<{ prompt: string } | { error: string } | null> {
    const parsed = codeStartersSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: (await getTranslations("polar"))("code.starterGone") };
    const { issueNumber, skill } = parsed.data;
    if (issueNumber === null && skill === null) return null;
    const body = input as { prompt?: unknown; repoId?: unknown };
    const typed = typeof body.prompt === "string" ? body.prompt : "";
    let repo = "";
    let issue = null;
    if (issueNumber !== null) {
        const reach =
            typeof body.repoId === "string" ? await repoReach(user.id, body.repoId) : null;
        const read = reach
            ? await readIssue(reach.owner, reach.name, issueNumber, reach.token)
            : null;
        if (!reach || !read) return { error: (await getTranslations("polar"))("code.issueGone") };
        repo = reach.fullName;
        issue = read;
    }
    let picked: StarterSkill | null = null;
    if (skill !== null) {
        picked = (await agentSkills(user.id, [skill]))[0] ?? null;
        if (!picked) return { error: (await getTranslations("polar"))("code.skillGone") };
    }
    return { prompt: starterPrompt(typed, repo, issue, picked) };
}

/** The default branch first, then the rest by name, each once. */
export function orderBranches(names: readonly string[], defaultBranch: string | null): string[] {
    const rest = [...new Set(names)]
        .filter((name) => name !== defaultBranch)
        .sort((a, b) => a.localeCompare(b));
    return defaultBranch ? [defaultBranch, ...rest] : rest;
}

/** Start a session: the Agents app's own start, with its own validation. */
export async function polarCodeStart(
    user: SessionUser,
    raw: unknown
): Promise<{ id?: string; error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const started = await promptWithStarters(user, raw);
    if (started && "error" in started) return { error: started.error };
    const typed = started
        ? started.prompt
        : typeof (raw as { prompt?: unknown } | null)?.prompt === "string"
          ? (raw as { prompt: string }).prompt
          : "";
    const asAgent = await promptWithAgent(user, raw, typed);
    if (asAgent && "error" in asAgent) return { error: asAgent.error };
    const prompt = asAgent?.prompt ?? started?.prompt;
    const { agentId: _agentId, goal: rawGoal, surface: rawSurface, ...body } = (raw ?? {}) as {
        agentId?: unknown;
        goal?: unknown;
        surface?: unknown;
    } & Record<string, unknown>;
    const surface = startSurfaceSchema.safeParse(rawSurface ?? "terminal");
    if (!surface.success) return { error: (await getTranslations("agents"))("sessions.errors.checkForm") };
    // `/goal` typed at the start: kept on the session from its creation, so its
    // first turn is judged (`lib/agents/session-goal.ts`).
    const goal = startGoalSchema.safeParse(rawGoal ?? null);
    if (!goal.success) return { error: (await getTranslations("polar"))("goal.tooLong", { max: GOAL_CONDITION_MAX }) };
    const resolved = await resolvedStart(user, body);
    if ("error" in resolved) return { error: resolved.error };
    const rest = resolved.input;
    const input = prompt !== undefined ? { ...rest, prompt } : rest;
    // A model picked here is Polar's list, so Polar's rule on whose keys this
    // person may spend holds: the deployment's only where the policy says so.
    const choice = core.sessionModelChoiceSchema.nullable().safeParse(
        (input as { modelChoice?: unknown } | null)?.modelChoice ?? null
    );
    // A tool that only takes the model's name (Claude Code, Codex, Gemini)
    // signs in with its own account, so there is no key to resolve for it.
    const cli = (input as { cli?: unknown } | null)?.cli;
    const keyed = typeof cli === "string" && core.MODEL_CHOICE_AGENT_CLIS.includes(cli);
    if (keyed && choice.success && choice.data) {
        const credential = await polarCredentialFor(
            user.id,
            choice.data.provider,
            choice.data.payer
        );
        if (!credential) return { error: (await getTranslations("agents"))("sessions.errors.noModelKey") };
        // Pinned to the key Polar resolved, so the session spends that one.
        return withSurface(
            await withGoal(
                await startSessionAction(
                    {
                        ...(input as object),
                        modelChoice: { ...choice.data, payer: credential.source }
                    },
                    asAgent?.rules ?? []
                ),
                goal.data
            ),
            surface.data
        );
    }
    return withSurface(await withGoal(await startSessionAction(input, asAgent?.rules ?? []), goal.data), surface.data);
}

const startSurfaceSchema = z.enum(acpProviders.SESSION_SURFACES);

/**
 * Holds the session just created in Chat when that was asked for and its agent
 * can be driven there. Before its first prompt, which waits for the machine:
 * that prompt then opens the Chat connection rather than the terminal's turn.
 */
async function withSurface<T extends { id?: string }>(started: T, surface: acpProviders.SessionSurface): Promise<T> {
    if (!started.id || surface !== "chat") return started;
    const row = await prisma.agentSession.findUnique({ where: { id: started.id }, select: { cli: true, place: true } });
    const place = core.AGENT_SESSION_PLACES.find((known) => known === row?.place);
    if (!row || !place || !acpProviders.chatAvailable(row.cli, place)) return started;
    await prisma.agentSession.update({ where: { id: started.id }, data: { surface }, select: { id: true } });
    return started;
}

const startGoalSchema = z.string().trim().min(1).max(GOAL_CONDITION_MAX).nullable();

/** Puts the start's `/goal` on the session just created. Its first prompt is
 *  delivered once the machine is up, well after this, so that turn is judged. */
async function withGoal<T extends { id?: string }>(started: T, condition: string | null): Promise<T> {
    if (started.id && condition) await setSessionGoal(started.id, condition);
    return started;
}

/**
 * Have this person's session machine waiting while they type. Called when Code
 * opens and again while it stays open; answers whether a spare is ready or on
 * its way. Nothing for somebody who could not start a session anyway.
 */
export async function polarCodeWarm(user: SessionUser): Promise<{ warm: boolean }> {
    if ((await accessOf(user)) !== "manage") return { warm: false };
    return { warm: await keepSpare(user.id) };
}

/** Say the next thing to a running session, through the Agents app's own reply. */
export async function polarCodePrompt(
    user: SessionUser,
    input: unknown
): Promise<{ error?: string; queued?: boolean }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return promptSessionAction(input);
}

const polarCodeGoalSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("set"),
        sessionId: z.string().trim().uuid(),
        condition: z.string().trim().min(1).max(GOAL_CONDITION_MAX)
    }).strict(),
    z.object({ action: z.literal("clear"), sessionId: z.string().trim().uuid() }).strict()
]);

/**
 * Set or clear a running session's `/goal` (`lib/agents/session-goal.ts`).
 * Setting one sends its condition as the next prompt, as Claude Code's /goal
 * starts a turn with it; a prompt that is refused takes the goal back off.
 */
export async function polarCodeGoal(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("polar");
    if ((await accessOf(user)) !== "manage") return { error: t("code.noAccess") };
    const parsed = polarCodeGoalSchema.safeParse(input);
    if (!parsed.success) return { error: t("goal.tooLong", { max: GOAL_CONDITION_MAX }) };
    const session = await getSession(parsed.data.sessionId, user.id);
    if (!session) return { error: t("code.goalFailed") };
    if (parsed.data.action === "clear") {
        await clearSessionGoal(session.id);
        return {};
    }
    if (core.isSessionOver(session.state) || core.isSessionQueued(session.state))
        return { error: t("code.goalFailed") };
    const goal = await setSessionGoal(session.id, parsed.data.condition);
    const sent = await promptSessionAction({ sessionId: session.id, text: goal.condition, attachments: [] });
    if (sent.error) await clearSessionGoal(session.id).catch(() => undefined);
    return sent;
}

/** Stop the turn a running session is on ("/stop"), as Escape does in its
 *  terminal; the session stays up for the next message. */
export async function polarCodeInterrupt(
    user: SessionUser,
    input: unknown
): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const parsed = polarCodeInterruptSchema.safeParse(input);
    // An id that is not one reads as a session that is not there.
    return interruptSessionAction(parsed.success ? parsed.data.sessionId : "");
}

/**
 * A finished subagent's own conversation, for whoever may read the session.
 * Asked by session and agent id: the transcript's path is looked up here and
 * never travels to the browser.
 */
export async function polarCodeSubagentTranscript(
    user: SessionUser,
    input: unknown
): Promise<SubagentTranscriptAnswer | null> {
    if ((await accessOf(user)) === "none") return null;
    const parsed = polarCodeSubagentSchema.safeParse(input);
    if (!parsed.success) return null;
    const { sessionId, agentId } = parsed.data;
    if (!(await getSession(sessionId, user.id))) return null;
    return readSubagentTranscript(sessionId, await subagentTranscriptRef(sessionId, agentId));
}

/** Change a running Claude session's model from its thread. */
export async function polarCodeModel(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return setSessionModelAction(input);
}

/** The models a running session can switch to, as its thread's picker offers
 *  them: those of the source it already signs in with, for a tool that changes
 *  model mid-session (Claude Code). `id` is what `polarCodeModel` takes;
 *  "default" is the account's own. Null when the session is not this person's
 *  to read. */
export async function polarCodeModels(
    user: SessionUser,
    sessionId: string
): Promise<{
    title: string;
    current: string;
    switchable: boolean;
    models: Array<{ id: string; name: string; provider: string }>;
} | null> {
    const thread = await polarCodeThread(user, sessionId);
    if (!thread) return null;
    const view = thread.view;
    const current = view.modelChoice?.model ?? "default";
    const switchable = thread.canManage && thread.session.live && core.takesPermissionMode(view.cli);
    if (!switchable) return { title: thread.session.title, current, switchable, models: [] };
    const choices = await polarCodeChoices(user);
    const source = choices ? liveSourceFor(choices.code.sources, view) : null;
    return {
        title: thread.session.title,
        current,
        switchable,
        models: (source?.models ?? []).map((model) => ({
            id: model.model ?? "default",
            name: model.name,
            provider: model.provider
        }))
    };
}

/** A repository named aloud, matched to one the person can start in: the full
 *  name, or the repository's own name without its owner. */
export function repositoryNamed<T extends { name: string }>(repos: readonly T[], spoken: string): T | null {
    const wanted = spoken.trim().toLowerCase();
    if (!wanted) return null;
    return (
        repos.find((repo) => repo.name.toLowerCase() === wanted) ??
        repos.find((repo) => repo.name.toLowerCase().split("/").at(-1) === wanted) ??
        null
    );
}

/**
 * A new session like `from` - the same tool, account, model and place - in
 * the same repository or the one named, with no first message: what is to be
 * done is sent to it next. Starts through `polarCodeStart`, so the same access
 * checks apply and the tool is resolved again from this person's own sources.
 */
export async function polarCodeStartLike(
    user: SessionUser,
    input: { from: string; title: string; repository: string | null }
): Promise<{ id?: string; error?: string }> {
    const thread = await polarCodeThread(user, input.from);
    if (!thread) return { error: "not_found" };
    const view = thread.view;
    let repoId = view.repoId;
    if (input.repository) {
        const choices = await polarCodeChoices(user);
        if (!choices) return { error: (await getTranslations("polar"))("code.noAccess") };
        const repo = repositoryNamed(choices.repos, input.repository);
        if (!repo) return { error: "no_repository" };
        repoId = repo.id;
    }
    return polarCodeStart(user, {
        repoId,
        title: input.title,
        cli: view.cli,
        ...(view.command ? { command: view.command } : {}),
        accountId: view.accountId,
        useMachineLogin: view.useMachineLogin,
        modelChoice: view.modelChoice,
        place: view.place,
        hostId: view.hostId,
        runnerId: view.runnerId,
        prompt: ""
    });
}

/** Change how hard a running Claude session thinks, from its thread. */
export async function polarCodeEffort(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return setSessionEffortAction(input);
}

/** The accounts a running session could move to, from its thread. */
export async function polarCodeAccounts(
    user: SessionUser,
    input: unknown
): Promise<Awaited<ReturnType<typeof sessionAccountsAction>> | { error: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const parsed = polarCodeInterruptSchema.safeParse(input);
    return parsed.success ? sessionAccountsAction(parsed.data.sessionId) : null;
}

/** Move a running session to another account, from its thread. */
export async function polarCodeSwitchAccount(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return switchSessionAccountAction(input);
}

/** Change a running session's permission mode from its thread. */
export async function polarCodeMode(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return setSessionModeAction(input);
}

/** Hold a running session in its terminal or in Chat, from its thread. */
export async function polarCodeSurface(user: SessionUser, input: unknown): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return setSessionSurfaceAction(input);
}

/** Take a session that has not started out of the queue, from its thread. One
 *  that started meanwhile is stopped the ordinary way. */
export async function polarCodeCancel(
    user: SessionUser,
    input: unknown
): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const parsed = polarCodeInterruptSchema.safeParse(input);
    return stopSessionAction(parsed.success ? parsed.data.sessionId : "");
}

/**
 * Carry on with a session that has ended, in a new one on the same work: its
 * branch, agent, account and machine, and the conversation so far where the
 * agent can take it. The Agents app's own fork, with every check a start makes.
 * A `target` moves it: to Polaris, one of the person's computers or servers.
 */
export async function polarCodeContinue(
    user: SessionUser,
    input: unknown
): Promise<{ id?: string; error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const parsed = continueSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("polar"))("code.continueFailed") };
    const { sessionId, target } = parsed.data;
    const answer = await forkSessionAction(sessionId, target ? placeOf(target) : undefined);
    return answer.id ? { id: answer.id } : { error: answer.error };
}

/**
 * Take a session out of the person's Code history, or rename it. Taking one
 * out needs only to be able to read it - it is their own list - and works only
 * once the session has finished; renaming changes the session for Agents too,
 * so it needs the right to manage. False when nothing changed.
 */
export async function polarCodeEdit(user: SessionUser, body: unknown): Promise<{ ok: boolean }> {
    const parsed = polarCodeEditSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    const access = await accessOf(user);
    const edit = parsed.data;
    if (edit.action === "delete") {
        if (access === "none") return { ok: false };
        return { ok: await hideSessionFromPolar(edit.sessionId, user.id) };
    }
    if (access !== "manage") return { ok: false };
    return { ok: await renameSession(edit.sessionId, user.id, edit.title) };
}

/**
 * Change a message waiting in a session's queue, or take it back. A taken-back
 * message answers with its text, for the reply box; one already sent answers
 * `gone`, so the screen can say it went.
 */
export async function polarCodeQueue(
    user: SessionUser,
    body: unknown
): Promise<{ text?: string; gone?: boolean; error?: string }> {
    const t = await getTranslations("polar");
    if ((await accessOf(user)) !== "manage") return { error: t("code.noAccess") };
    const parsed = polarCodeQueueSchema.safeParse(body);
    if (!parsed.success) return { error: t("code.queue.invalid") };
    const edit = parsed.data;
    // Only the person who started the session steers it.
    if (!(await getSession(edit.sessionId, user.id))) return { error: t("code.queue.invalid") };
    if (edit.action === "edit")
        return (await promptQueue.editQueuedPrompt(edit.sessionId, edit.id, edit.text)) ? {} : { gone: true };
    const text = await promptQueue.takeBackQueuedPrompt(edit.sessionId, edit.id);
    return text === null ? { gone: true } : { text };
}

/** A session's transcript as a file in one of the formats, or null when this
 *  reader cannot open the session. */
export async function polarCodeTranscript(
    user: SessionUser,
    sessionId: string,
    format: transcript.TranscriptFormat
): Promise<{ name: string; type: string; body: string } | null> {
    const thread = await polarCodeThread(user, sessionId);
    if (!thread) return null;
    const session: transcript.TranscriptSession = {
        id: thread.view.id,
        title: thread.view.title,
        repo: thread.session.repo,
        branch: thread.session.branch,
        cli: thread.view.cli,
        createdAt: thread.session.createdAt
    };
    const t = await getTranslations("polar");
    const body =
        format === "md"
            ? transcript.transcriptMarkdown(session, thread.entries, {
                  you: t("code.transcript.you"),
                  agent: t("code.transcript.agent"),
                  polaris: t("code.transcript.polaris"),
                  repository: t("code.transcript.repository"),
                  branch: t("code.transcript.branch"),
                  started: t("code.transcript.started"),
                  steps: t("code.transcript.steps")
              })
            : transcript.transcriptJsonl(session, thread.entries);
    return { ...transcript.transcriptFile(session, format), body };
}
