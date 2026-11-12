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
import { getTranslations } from "@/lib/i18n/request";
import { prisma } from "@polaris/db";
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
import { composerAgentsFor, type ComposerAgent } from "@/lib/polar/agents/composer-agents";
import { codeStartersSchema, starterPrompt, type StarterSkill } from "@/lib/polar/code-starters";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { userHasManage, type SessionUser } from "@/lib/session";
import { sessionCursor } from "@/lib/agents/session-cursor";
import { dedupeCodeRows, POLAR_CODE_PAGE, polarCodeEditSchema } from "@/lib/polar/code-history";
import { agentText, SESSION_EVENT_KEYS, sessionStateWord } from "@/lib/agents/words";
import * as repoOptions from "@/lib/agents/repo-options";
import {
    getSession,
    hideSessionFromPolar,
    renameSession,
    type SessionView
} from "@/lib/agents/session-service";
import { keepSpare } from "@/lib/agents/session-spares";
import { pendingPermission, type PendingPermission } from "@/lib/agents/session-permissions";
import {
    forkSessionAction,
    listSessionsAction,
    promptSessionAction,
    sessionChoicesAction,
    sessionDetailAction,
    startSessionAction
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
}

/** As many lines of activity as the thread shows; the session's own page keeps
 *  the rest. */
const EVENTS_SHOWN = 80;

async function accessOf(user: SessionUser): Promise<PolarCodeAccess> {
    if (await userHasManage(user, "agents.manage")) return "manage";
    if (await userHasManage(user, "agents.read")) return "read";
    return "none";
}

function rowOf(
    t: NamespaceTranslator<"agents">,
    session: {
        id: string;
        title: string;
        repoFullName: string;
        branch: string;
        state: core.AgentSessionState;
        lastEventAt: string | null;
        createdAt: string;
    }
): PolarCodeRow {
    return {
        id: session.id,
        title: session.title,
        repo: session.repoFullName,
        branch: session.branch,
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

/** One session as the thread shows it, or null when it is not this account's. */
export async function polarCodeThread(
    user: SessionUser,
    sessionId: string
): Promise<PolarCodeThread | null> {
    const access = await accessOf(user);
    if (access === "none") return null;
    const [detail, t] = await Promise.all([
        sessionDetailAction(sessionId),
        getTranslations("agents")
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
        text: message.body,
        detail: ""
    }));
    const events: PolarCodeEntry[] = detail.events.slice(-EVENTS_SHOWN).map((event) => {
        const key = SESSION_EVENT_KEYS[event.kind];
        return {
            at: event.at,
            type: "event",
            role: event.kind,
            text: key ? t(key) : event.kind,
            detail:
                event.kind === "session.end"
                    ? endReason(t, event.detail)
                    : event.detail
                      ? agentText(t, event.detail)
                      : event.subject
        };
    });
    // Stable on equal times, so a prompt and the event it caused keep the order
    // they were written in.
    const entries = [...messages, ...events].sort((a, b) => a.at.localeCompare(b.at));
    return {
        session: rowOf(t, detail.session),
        entries,
        error: detail.session.error ? agentText(t, detail.session.error) : null,
        view: detail.session,
        canManage: access === "manage",
        permission
    };
}

export type PolarCodeChoices = Awaited<ReturnType<typeof sessionChoicesAction>> & {
    /** GitHub's page for installing Polaris's App on more repositories, or null
     *  where no App is set up (a token connection, or none). */
    readonly installUrl: string | null;
    /** The person's Polar skills a task can start with, by name. */
    readonly skills: readonly { name: string; description: string }[];
    /** The agents the composer offers, one row each, with their accounts and
     *  models (`composer-agents.ts`). */
    readonly composer: readonly ComposerAgent[];
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
    const composer = await composerAgentsFor(user.id, choices.agents).catch((error: unknown) => {
        console.error("polar: could not list the composer's agents", error);
        return [];
    });
    return {
        ...choices,
        installUrl,
        skills: skills.map(({ name, description }) => ({ name, description })),
        composer
    };
}

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
): Promise<{ prompt: string } | { error: string } | null> {
    const body = input as { agentId?: unknown; cli?: unknown } | null;
    if (body?.agentId === undefined || body.agentId === null) return null;
    const agent = typeof body.agentId === "string" ? await agentFor(user.id, body.agentId) : null;
    if (!agent || agent.engine !== body.cli) {
        return { error: (await getTranslations("polar"))("code.agentGone") };
    }
    return { prompt: agentTaskPrompt(agent, prompt) };
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
    const { agentId: _agentId, ...rest } = (raw ?? {}) as { agentId?: unknown };
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
        return startSessionAction({
            ...(input as object),
            modelChoice: { ...choice.data, payer: credential.source }
        });
    }
    return startSessionAction(input);
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
): Promise<{ error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return promptSessionAction(input);
}

/**
 * Carry on with a session that has ended, in a new one on the same work: its
 * branch, agent, account and machine, and the conversation so far where the
 * agent can take it. The Agents app's own fork, with every check a start makes.
 */
export async function polarCodeContinue(
    user: SessionUser,
    input: unknown
): Promise<{ id?: string; error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    const sessionId = (input as { sessionId?: unknown } | null)?.sessionId;
    const answer = await forkSessionAction(typeof sessionId === "string" ? sessionId : "");
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
