/**
 * Agent sessions, as rows.
 *
 * The database half: creating one, listing them, recording what a machine
 * reported, and letting a session prove it is the one it says it is. What
 * actually starts, steers and stops a process lives in `session-runtime.ts` -
 * split because this half is exercisable without a machine and that half is not.
 *
 * Ownership is the repository's. A session belongs to the AgentRepo it works in,
 * and reaching that repository is what reaching the session means, so there is no
 * second answer to "may I" here that could drift from the first.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";

/**
 * A failure whose message is meant for whoever is reading the screen.
 *
 * The distinction this draws is the whole reason it exists. A session that will
 * not start fails somewhere down a stack of things a person has never heard of -
 * a daemon rejecting an environment value, a socket that refused, an SSH host key
 * - and the message from any of those is worse than useless on a screen: it names
 * internals, it suggests nothing to do, and where it quotes an address or a path
 * it hands out something nobody asked to publish.
 *
 * So only what is thrown as one of these is shown. Everything else is logged and
 * reported as a sentence that says what happened without pretending to explain
 * it. A message here has to pass the test every message in Polaris passes: it
 * says what is wrong in terms the reader can see, and where there is something to
 * press, it says what.
 */
export class SessionRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionRefusal";
    }
}

/**
 * What to put on a session that would not start.
 *
 * The general sentence is deliberately not an apology and not a stack trace: it
 * says the session is the thing to look at, which is true, and the events on it
 * are what a person can actually read.
 */
export function readableFailure(error: unknown, context: string): string {
    if (error instanceof SessionRefusal) return error.message;
    console.error(`[agent-session] ${context}:`, error);
    return "Polaris could not start this session. Nothing was left running.";
}

export interface SessionView {
    readonly id: string;
    readonly title: string;
    /** Whose credentials this session runs on. Whoever started it: a session
     *  spends the account of the person who asked for it, never the
     *  repository's, and null on one started before this was recorded. */
    readonly ownerId: string | null;
    readonly repoId: string;
    readonly repoFullName: string;
    readonly cli: string;
    readonly command: string | null;
    readonly place: core.AgentSessionPlace;
    readonly hostId: string | null;
    readonly hostName: string | null;
    readonly state: core.AgentSessionState;
    readonly detail: string;
    readonly branch: string;
    readonly baseRef: string;
    readonly taskId: string | null;
    readonly error: string | null;
    readonly lastEventAt: string | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly createdAt: string;
}

const VIEW_SELECT = {
    id: true,
    title: true,
    startedById: true,
    repoId: true,
    cli: true,
    command: true,
    place: true,
    hostId: true,
    state: true,
    detail: true,
    branch: true,
    baseRef: true,
    taskId: true,
    error: true,
    lastEventAt: true,
    startedAt: true,
    finishedAt: true,
    createdAt: true,
    repo: { select: { repoFullName: true } },
    host: { select: { name: true } }
} as const;

type SessionRecord = {
    [K in keyof typeof VIEW_SELECT]: unknown;
} & {
    id: string;
    title: string;
    startedById: string | null;
    repoId: string;
    cli: string;
    command: string | null;
    place: string;
    hostId: string | null;
    state: string;
    detail: string;
    branch: string;
    baseRef: string;
    taskId: string | null;
    error: string | null;
    lastEventAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
    repo: { repoFullName: string };
    host: { name: string } | null;
};

/** A stored state column is not a type: a newer build could have written one this
 *  one has never heard of, and a screen that rendered it raw would show a word
 *  nobody can act on. */
function readState(value: string): core.AgentSessionState {
    return (core.AGENT_SESSION_STATES as readonly string[]).includes(value)
        ? (value as core.AgentSessionState)
        : "failed";
}

function toView(record: SessionRecord): SessionView {
    return {
        id: record.id,
        title: record.title,
        ownerId: record.startedById,
        repoId: record.repoId,
        repoFullName: record.repo.repoFullName,
        cli: record.cli,
        command: record.command,
        place: record.place === "host" ? "host" : "local",
        hostId: record.hostId,
        hostName: record.host?.name ?? null,
        state: readState(record.state),
        detail: record.detail,
        branch: record.branch,
        baseRef: record.baseRef,
        taskId: record.taskId,
        error: record.error,
        lastEventAt: record.lastEventAt?.toISOString() ?? null,
        startedAt: record.startedAt?.toISOString() ?? null,
        finishedAt: record.finishedAt?.toISOString() ?? null,
        createdAt: record.createdAt.toISOString()
    };
}

/** Every session in the repositories this account holds, newest first. */
export async function listSessions(ownerId: string, options: { repoId?: string; live?: boolean } = {}): Promise<
    SessionView[]
> {
    const records = await prisma.agentSession.findMany({
        where: {
            repo: { ownerId },
            ...(options.repoId ? { repoId: options.repoId } : {}),
            ...(options.live ? { state: { notIn: ["stopped", "failed"] } } : {})
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: VIEW_SELECT
    });
    return (records as unknown as SessionRecord[]).map(toView);
}

/** One session, or null when this account does not reach it. Deliberately the
 *  same answer for "no such session" and "not yours". */
export async function getSession(sessionId: string, ownerId: string): Promise<SessionView | null> {
    const record = await prisma.agentSession.findFirst({
        where: { id: sessionId, repo: { ownerId } },
        select: VIEW_SELECT
    });
    return record ? toView(record as unknown as SessionRecord) : null;
}

export interface SessionCreateInput {
    readonly repoId: string;
    readonly startedById: string;
    readonly title: string;
    readonly cli: string;
    readonly command: string | null;
    readonly place: core.AgentSessionPlace;
    readonly hostId: string | null;
    readonly baseRef: string;
    readonly taskId: string | null;
    readonly enigma: core.EnigmaSettings | null;
}

/**
 * Create the row, and mint the credential the machine will report with.
 *
 * The token is returned once and never stored - only its hash is - so a database
 * dump cannot be replayed as a live reporting credential. The branch is minted
 * here rather than by the runtime because it has to be stable from the moment the
 * session exists: it is what a person looks for in the branch list a week later,
 * and a session that failed to start still has one worth naming.
 */
export async function createSession(input: SessionCreateInput): Promise<{ session: SessionView; token: string }> {
    const token = generateToken();
    const id = crypto.randomUUID();
    const record = await prisma.agentSession.create({
        data: {
            id,
            repoId: input.repoId,
            startedById: input.startedById,
            title: input.title,
            cli: input.cli,
            command: input.command,
            place: input.place,
            hostId: input.hostId,
            baseRef: input.baseRef,
            branch: core.sessionBranchName(id, input.title),
            taskId: input.taskId,
            enigma: input.enigma ? JSON.stringify(input.enigma) : null,
            tokenHash: hashToken(token),
            state: "starting"
        },
        select: VIEW_SELECT
    });
    return { session: toView(record as unknown as SessionRecord), token };
}

/**
 * The session a reporting token belongs to, or null.
 *
 * A token stops working the moment its session is over, which is what stops a
 * finished session's credential being replayed to write events into a screen
 * nobody is watching any more.
 */
export async function sessionForToken(
    token: string
): Promise<{ id: string; state: core.AgentSessionState; taskId: string | null } | null> {
    if (!token) return null;
    const record = await prisma.agentSession.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, state: true, taskId: true }
    });
    if (!record) return null;
    const state = readState(record.state);
    if (core.isSessionOver(state)) return null;
    return { id: record.id, state, taskId: record.taskId };
}

/** Whose work a session is doing: the account that owns the repository it runs
 *  in. What the tools it is given act as, so a session can never reach past the
 *  person who started it. */
export async function sessionOwner(sessionId: string): Promise<string | null> {
    const record = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { repo: { select: { ownerId: true } } }
    });
    return record?.repo.ownerId ?? null;
}

/**
 * Record what a session reported.
 *
 * The state is derived from the events rather than sent: a machine says what
 * happened, and what that means is Polaris's to decide. `detail` keeps the last
 * thing worth showing rather than the last event of any kind, so a session that
 * finished a turn still says what it was doing when it did.
 */
export async function recordSessionEvents(
    sessionId: string,
    events: readonly { kind: core.AgentSessionEventKind; detail: string; subject: string }[]
): Promise<core.AgentSessionState | null> {
    if (events.length === 0) return null;
    const current = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { state: true } });
    if (!current) return null;

    const state = core.replaySessionState(events, readState(current.state));
    const spoken = [...events].reverse().find((event) => event.detail !== "");

    await prisma.$transaction([
        prisma.agentSessionEvent.createMany({
            data: events.map((event) => ({
                sessionId,
                kind: event.kind,
                detail: event.detail,
                subject: event.subject
            }))
        }),
        prisma.agentSession.update({
            where: { id: sessionId },
            data: {
                state,
                lastEventAt: new Date(),
                ...(spoken ? { detail: spoken.detail } : {}),
                ...(core.isSessionOver(state) ? { finishedAt: new Date() } : {})
            }
        })
    ]);
    return state;
}

/** What a session has reported, oldest first. */
export async function sessionEvents(
    sessionId: string,
    limit = 200
): Promise<{ kind: string; detail: string; subject: string; at: string }[]> {
    const records = await prisma.agentSessionEvent.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { kind: true, detail: true, subject: true, createdAt: true }
    });
    return records
        .map((record) => ({
            kind: record.kind,
            detail: record.detail,
            subject: record.subject,
            at: record.createdAt.toISOString()
        }))
        .reverse();
}

/** Something said in the session, by a person or by Polaris on their behalf. */
export async function addSessionMessage(
    sessionId: string,
    role: "user" | "agent" | "system",
    body: string,
    authorId: string | null = null
): Promise<void> {
    await prisma.agentSessionMessage.create({ data: { sessionId, role, body, authorId } });
}

export async function sessionMessages(
    sessionId: string,
    limit = 100
): Promise<{ role: string; body: string; authorId: string | null; at: string }[]> {
    const records = await prisma.agentSessionMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { role: true, body: true, authorId: true, createdAt: true }
    });
    return records
        .map((record) => ({
            role: record.role,
            body: record.body,
            authorId: record.authorId,
            at: record.createdAt.toISOString()
        }))
        .reverse();
}

/** Note that the machine got as far as having a process. */
export async function markSessionStarted(sessionId: string, containerId: string, workdir: string): Promise<void> {
    await prisma.agentSession.update({
        where: { id: sessionId },
        data: { containerId, workdir, state: "idle", startedAt: new Date(), lastEventAt: new Date() }
    });
}

/**
 * End a session, for the reason given.
 *
 * The token is cleared rather than left to expire. A session that has stopped has
 * no more events to report, and a credential with nothing left to do is a
 * credential that should not still work.
 */
export async function finishSession(
    sessionId: string,
    state: "stopped" | "failed",
    error: string | null = null
): Promise<void> {
    await prisma.agentSession.update({
        where: { id: sessionId },
        data: { state, error, tokenHash: null, finishedAt: new Date() }
    });
}

/** Where a session runs and what it is running, for the runtime. Separate from
 *  the view because none of it belongs on a screen. */
export async function sessionPlacement(sessionId: string): Promise<{
    id: string;
    place: core.AgentSessionPlace;
    hostId: string | null;
    containerId: string | null;
    workdir: string;
    state: core.AgentSessionState;
} | null> {
    const record = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { id: true, place: true, hostId: true, containerId: true, workdir: true, state: true }
    });
    if (!record) return null;
    return {
        id: record.id,
        place: record.place === "host" ? "host" : "local",
        hostId: record.hostId,
        containerId: record.containerId,
        workdir: record.workdir,
        state: readState(record.state)
    };
}

/**
 * The Enigma setup a session runs under, resolved down the tiers.
 *
 * Session, then repository, then that account's defaults for this owner, then the
 * instance's. Nothing resolved is ever stored: the moment it is, changing the
 * instance default stops reaching the sessions that were meant to follow it.
 */
export async function resolveSessionEnigma(sessionId: string): Promise<core.ResolvedEnigma> {
    const session = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { enigma: true, repo: { select: { enigma: true, gate: true, ownerId: true, repoFullName: true } } }
    });
    if (!session) return core.resolveEnigma();

    const owner = session.repo.ownerId;
    const account = session.repo.repoFullName.split("/")[0] ?? "";
    const tiers = await prisma.agentDefaults.findMany({
        where: { ownerId: owner, scope: { in: [account, ""] } },
        select: { scope: true, enigma: true, gate: true }
    });
    const byScope = (scope: string): core.EnigmaSettings => {
        const row = tiers.find((tier) => tier.scope === scope);
        if (!row) return core.INHERIT_ENIGMA;
        const parsed = core.parseEnigmaSettings(row.enigma);
        // `gate` predates this settings column and is still its own field on the
        // tier, so it is folded in here rather than being asked for twice.
        return parsed.gate === null && row.gate && core.isEnigmaGateMode(row.gate)
            ? { ...parsed, gate: row.gate }
            : parsed;
    };

    const repoSettings = core.parseEnigmaSettings(session.repo.enigma);
    const repoTier: core.EnigmaSettings =
        repoSettings.gate === null && session.repo.gate && core.isEnigmaGateMode(session.repo.gate)
            ? { ...repoSettings, gate: session.repo.gate }
            : repoSettings;

    return core.resolveEnigma(core.parseEnigmaSettings(session.enigma), repoTier, byScope(account), byScope(""));
}
