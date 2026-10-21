/**
 * Reviewing and shipping a session's work: what it changed, and the pull request
 * that turns it into something a team can review.
 *
 * Both read the session's own checkout, so both need it to still exist. A
 * container session's checkout goes with its container when the session ends -
 * unless its work was kept because it could not be pushed - and a server
 * session's stays on that server. Which of those a session is decides whether
 * there is anything here to read, and the page says so in those terms.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as changes from "./session-changes";
import * as github from "@/lib/github-service";
import { runInSession } from "./session-runtime";
import { saveSessionWork, type SaveOutcome } from "./session-work";
import type { SessionView, SessionWorkReason } from "./session-service";

/** Why a session's checkout cannot be read right now. */
export type ChangesUnavailable = "workspace" | "ended" | "starting";

/** Whether this session has a checkout to read, or why not. */
export function changesUnavailable(
    session: Pick<SessionView, "repoFullName" | "place" | "state" | "work">,
    hasMachine: boolean
): ChangesUnavailable | null {
    if (!session.repoFullName) return "workspace";
    // A server keeps the worktree after the session ends; a container keeps it
    // only while the work in it could not be pushed.
    const over = core.isSessionOver(session.state);
    if (session.place === "local" && over && session.work?.state !== "kept") return "ended";
    if (!hasMachine) return over ? "ended" : "starting";
    return null;
}

async function machineOf(sessionId: string): Promise<{ workdir: string; hasMachine: boolean }> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { place: true, hostId: true, containerId: true, workdir: true }
    });
    return {
        workdir: row?.workdir ?? "",
        hasMachine: Boolean(row && (row.place === "host" ? row.hostId : row.containerId))
    };
}

export type ChangesAnswer =
    | { kind: "listing"; listing: changes.ChangesListing }
    | { kind: "unavailable"; reason: ChangesUnavailable }
    | { kind: "unreachable" };

/** One page of the files a session changed. */
export async function listSessionChanges(
    session: SessionView,
    offset: number
): Promise<ChangesAnswer> {
    const machine = await machineOf(session.id);
    const unavailable = changesUnavailable(session, machine.hasMachine);
    if (unavailable) return { kind: "unavailable", reason: unavailable };
    try {
        const script = changes.listChangesScript({
            workdir: machine.workdir,
            baseRef: session.baseRef,
            offset
        });
        const result = await runInSession(session.id, script, { evenIfFinished: true });
        const listing = changes.parseChangesList(result.output);
        if (listing) return { kind: "listing", listing };
        console.error(`polaris: listing the changes of session ${session.id} said nothing usable`);
    } catch (error) {
        console.error(`polaris: could not read the changes of session ${session.id}:`, error);
    }
    return { kind: "unreachable" };
}

export type DiffAnswer =
    | { kind: "diff"; diff: changes.FileDiff }
    | { kind: "unavailable"; reason: ChangesUnavailable }
    | { kind: "unreachable" };

/** One file's diff against the session's base. */
export async function sessionFileDiff(session: SessionView, path: string): Promise<DiffAnswer> {
    const machine = await machineOf(session.id);
    const unavailable = changesUnavailable(session, machine.hasMachine);
    if (unavailable) return { kind: "unavailable", reason: unavailable };
    try {
        const diff = await changes.readFileDiff(async (offset) => {
            const script = changes.fileDiffScript({
                workdir: machine.workdir,
                baseRef: session.baseRef,
                path,
                offset
            });
            return (await runInSession(session.id, script, { evenIfFinished: true })).output;
        });
        return { kind: "diff", diff };
    } catch (error) {
        console.error(`polaris: could not read a diff of session ${session.id}:`, error);
        return { kind: "unreachable" };
    }
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/** Why a pull request could not be opened, as a code the page words itself. */
export const SHIP_REFUSALS = [
    "workspace",
    "readOnly",
    "noAuth",
    "push",
    "noChanges",
    "missing",
    "github"
] as const;
export type ShipRefusal = (typeof SHIP_REFUSALS)[number];

/** Whether this session can ship at all, before anybody presses anything: the
 *  reason the button is not offered, or null when it is. */
export function shipBlocked(
    session: Pick<SessionView, "repoFullName">,
    push: string | null
): ShipRefusal | null {
    if (!session.repoFullName) return "workspace";
    if (push === "disabled") return "readOnly";
    return null;
}

const TITLE_MAX = 256;
const BODY_MAX = 60_000;

/** A pull request's title and body, from the session's task and its first
 *  prompt. The sentences come in the reader's language, from the catalogue. */
export function pullRequestDraft(input: {
    title: string;
    prompt: string | null;
    sessionUrl: string;
    words: { fallbackTitle: string; asked: string; openedFrom: (url: string) => string };
}): { title: string; body: string } {
    const title =
        input.title.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX) || input.words.fallbackTitle;
    const prompt = input.prompt?.trim() ?? "";
    const quoted = prompt
        ? prompt
              .slice(0, 4000)
              .split("\n")
              .map((line) => `> ${line}`.trimEnd())
              .join("\n")
        : "";
    const body = [
        quoted ? `${input.words.asked}\n\n${quoted}` : "",
        input.words.openedFrom(input.sessionUrl)
    ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, BODY_MAX);
    return { title, body };
}

export interface ShipDeps {
    token: (owner: string) => Promise<string | null>;
    push: (session: ShipSession) => Promise<SaveOutcome>;
    pullsForBranch: (
        owner: string,
        repo: string,
        branch: string,
        token: string
    ) => Promise<github.BranchPullRequest[] | null>;
    defaultBranch: (owner: string, repo: string, token: string) => Promise<string | null>;
    create: (
        owner: string,
        repo: string,
        input: { head: string; base: string; title: string; body: string },
        token: string
    ) => Promise<github.CreatePullResult>;
    record: (sessionId: string, pull: github.BranchPullRequest) => Promise<void>;
}

const defaultDeps: ShipDeps = {
    token: (owner) => github.githubAppInstallationToken(owner).catch(() => null),
    push: async (session) => {
        // A checkout that is gone pushed what it had when it ended.
        if (changesUnavailable(session, (await machineOf(session.id)).hasMachine))
            return { kind: "none" };
        return saveSessionWork(session.id, {
            message: "Work from the agent session",
            neverDefault: true,
            host: (script) => runInSession(session.id, script, { evenIfFinished: true })
        });
    },
    pullsForBranch: github.pullRequestsForBranch,
    defaultBranch: github.repoDefaultBranch,
    create: github.createPullRequest,
    record: async (sessionId, pull) => {
        await prisma.agentSession.update({
            where: { id: sessionId },
            data: { prNumber: pull.number, prUrl: pull.url }
        });
    }
};

export type ShipResult =
    | { kind: "opened" | "existing"; pull: github.BranchPullRequest }
    | { kind: "refused"; reason: ShipRefusal; pushReason?: SessionWorkReason };

/** The one of a branch's pull requests to show: an open one, else a merged one.
 *  A closed one that was never merged is a proposal somebody turned down, and
 *  shipping again is asking for a new one. */
export function reusablePull(
    pulls: readonly github.BranchPullRequest[]
): github.BranchPullRequest | null {
    return (
        pulls.find((pull) => pull.state === "open") ??
        pulls.find((pull) => pull.state === "merged") ??
        null
    );
}

/**
 * Push the session's branch and open its pull request, or find the one it has.
 *
 * Never two: the branch's own pull requests are asked for after the push and
 * again when GitHub says one already exists, and the one found is what the
 * session links. The push is never forced and never to the default branch.
 */
export type ShipSession = Pick<
    SessionView,
    "id" | "repoFullName" | "branch" | "baseRef" | "place" | "state" | "work"
>;

export async function openSessionPullRequest(
    session: ShipSession,
    push: string | null,
    draft: { title: string; body: string },
    deps: ShipDeps = defaultDeps
): Promise<ShipResult> {
    const blocked = shipBlocked(session, push);
    if (blocked) return { kind: "refused", reason: blocked };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await deps.token(owner);
    if (!token) return { kind: "refused", reason: "noAuth" };

    // What is in the checkout goes up first, so the pull request has it. A
    // session whose checkout is gone already pushed whatever it had when it
    // ended, and the branch on GitHub is what there is.
    const pushed = await deps.push(session);
    if (pushed.kind === "kept") {
        if (pushed.reason === "policy") return { kind: "refused", reason: "readOnly" };
        return { kind: "refused", reason: "push", pushReason: pushed.reason };
    }

    const found = await deps.pullsForBranch(owner, repo, session.branch, token);
    const existing = found ? reusablePull(found) : null;
    if (existing) {
        await deps.record(session.id, existing);
        return { kind: "existing", pull: existing };
    }

    const base = session.baseRef || (await deps.defaultBranch(owner, repo, token));
    if (!base) return { kind: "refused", reason: "github" };
    if (base === session.branch) return { kind: "refused", reason: "noChanges" };
    const created = await deps.create(
        owner,
        repo,
        { head: session.branch, base, title: draft.title, body: draft.body },
        token
    );
    if (created.ok) {
        await deps.record(session.id, created.pull);
        return { kind: "opened", pull: created.pull };
    }
    if (created.reason === "exists") {
        const again = await deps.pullsForBranch(owner, repo, session.branch, token);
        const pull = again ? reusablePull(again) : null;
        if (pull) {
            await deps.record(session.id, pull);
            return { kind: "existing", pull };
        }
        return { kind: "refused", reason: "github" };
    }
    if (created.reason === "noChanges") return { kind: "refused", reason: "noChanges" };
    if (created.reason === "missing") return { kind: "refused", reason: "missing" };
    return { kind: "refused", reason: "github" };
}

/** The linked pull request as it stands on GitHub now, or null when GitHub
 *  would not say - the page then shows the link without a state. */
export async function linkedPullRequest(
    session: Pick<SessionView, "repoFullName" | "pullRequest">
): Promise<github.BranchPullRequest | null> {
    if (!session.pullRequest || !session.repoFullName) return null;
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await github.githubAppInstallationToken(owner).catch(() => null);
    return github.readPullRequest(owner, repo, session.pullRequest.number, token);
}

/** The repository's push setting for a session, or null for a workspace. */
export async function sessionPushSetting(sessionId: string): Promise<string | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { repo: { select: { push: true } } }
    });
    return row?.repo?.push ?? null;
}
