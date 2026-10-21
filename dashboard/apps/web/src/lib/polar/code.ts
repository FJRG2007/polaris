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
import { githubAppInstallUrl } from "@/lib/github-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { userHasManage, type SessionUser } from "@/lib/session";
import { sessionCursor } from "@/lib/agents/session-cursor";
import { dedupeCodeRows, POLAR_CODE_PAGE } from "@/lib/polar/code-history";
import { agentText, SESSION_EVENT_KEYS, sessionStateWord } from "@/lib/agents/words";
import {
    listSessionsAction,
    promptSessionAction,
    sessionChoicesAction,
    sessionDetailAction,
    startSessionAction
} from "@/app/(app)/apps/agents/sessions/actions";

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
        listSessionsAction(POLAR_CODE_PAGE + 1, { mine: true, ...(after ? { after } : {}) }),
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

/** One session as the thread shows it, or null when it is not this account's. */
export async function polarCodeThread(
    user: SessionUser,
    sessionId: string
): Promise<PolarCodeThread | null> {
    if ((await accessOf(user)) === "none") return null;
    const [detail, t] = await Promise.all([
        sessionDetailAction(sessionId),
        getTranslations("agents")
    ]);
    if (!detail) return null;
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
            detail: event.detail ? agentText(t, event.detail) : event.subject
        };
    });
    // Stable on equal times, so a prompt and the event it caused keep the order
    // they were written in.
    const entries = [...messages, ...events].sort((a, b) => a.at.localeCompare(b.at));
    return {
        session: rowOf(t, detail.session),
        entries,
        error: detail.session.error ? agentText(t, detail.session.error) : null
    };
}

export type PolarCodeChoices = Awaited<ReturnType<typeof sessionChoicesAction>> & {
    /** GitHub's page for installing Polaris's App on more repositories, or null
     *  where no App is set up (a token connection, or none). */
    readonly installUrl: string | null;
};

/** What the composer offers - repositories and agents - or null for somebody
 *  who cannot start a session. */
export async function polarCodeChoices(user: SessionUser): Promise<PolarCodeChoices | null> {
    if ((await accessOf(user)) !== "manage") return null;
    const [choices, installUrl] = await Promise.all([
        sessionChoicesAction(),
        // Unknown is no button rather than no choices.
        githubAppInstallUrl().catch(() => null)
    ]);
    return { ...choices, installUrl };
}

/** Start a session: the Agents app's own start, with its own validation. */
export async function polarCodeStart(
    user: SessionUser,
    input: unknown
): Promise<{ id?: string; error?: string }> {
    if ((await accessOf(user)) !== "manage")
        return { error: (await getTranslations("polar"))("code.noAccess") };
    return startSessionAction(input);
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
