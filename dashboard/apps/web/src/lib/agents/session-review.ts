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
import * as prFacts from "./session-pr-facts";
import * as timelines from "./session-pr-timeline";
import { githubTokenForUser } from "@/lib/github-access";
import type { SessionView, SessionWorkReason } from "./session-service";
import { readComputerWorkspace } from "@/lib/computers/computer-workspace";

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
    const computer = computerCheckout(session);
    if (computer) {
        const answer = await readComputerWorkspace(computer, { kind: "changes", baseRef: session.baseRef, offset });
        return computerChanges(answer);
    }
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
    const computer = computerCheckout(session);
    if (computer) {
        const answer = await readComputerWorkspace(computer, { kind: "diff", baseRef: session.baseRef, path });
        return computerDiff(answer);
    }
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

/** A live session on a computer that has a checkout to read: a clone of its
 *  repository or a folder chosen there. Null for any other session. */
function computerCheckout(
    session: Pick<SessionView, "id" | "place" | "runnerId" | "state" | "repoFullName" | "localFolder">
): { id: string; runnerId: string } | null {
    if (session.place !== "computer" || !session.runnerId) return null;
    if (core.isSessionOver(session.state)) return null;
    if (!session.repoFullName && !session.localFolder) return null;
    return { id: session.id, runnerId: session.runnerId };
}

/** A computer's answer to a changes read, in this module's words. Pure. */
export function computerChanges(answer: core.WorkspaceAnswer | null): ChangesAnswer {
    switch (answer?.kind) {
        case "changes":
            return {
                kind: "listing",
                listing: { kind: "ok", base: answer.base, total: answer.total, files: answer.files, next: answer.next }
            };
        case "nocheckout":
        case "nobase":
            return { kind: "listing", listing: { kind: answer.kind } };
        default:
            return { kind: "unreachable" };
    }
}

/** A computer's answer to a diff read, in this module's words. Pure. */
export function computerDiff(answer: core.WorkspaceAnswer | null): DiffAnswer {
    switch (answer?.kind) {
        case "diff":
            return { kind: "diff", diff: { kind: "diff", text: answer.text } };
        case "diffLarge":
            return { kind: "diff", diff: { kind: "large", size: answer.size } };
        case "binary":
            return { kind: "diff", diff: { kind: "binary" } };
        case "gone":
        case "nocheckout":
        case "nobase":
            return { kind: "diff", diff: { kind: answer.kind } };
        default:
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
    pullsForBranch: (...args) => github.pullRequestsForBranch(...args),
    defaultBranch: (...args) => github.repoDefaultBranch(...args),
    create: (...args) => github.createPullRequest(...args),
    record: async (sessionId, pull) => {
        const session = await prisma.agentSession.update({
            where: { id: sessionId },
            data: { prNumber: pull.number, prUrl: pull.url },
            select: { repo: { select: { repoFullName: true } } }
        });
        // A baseline the poll reads first, so its facts arrive even where no
        // webhook does.
        if (session.repo) await prFacts.seedPullFacts(sessionId, session.repo.repoFullName, pull.number, pull.url);
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

    // A merged one only stands for the branch while nothing came after it: work
    // the agent did since is a new proposal.
    const found = await deps.pullsForBranch(owner, repo, session.branch, token);
    const existing = found?.find((pull) => pull.state === "open") ?? null;
    if (existing) {
        await deps.record(session.id, existing);
        return { kind: "existing", pull: existing };
    }
    const merged = found ? reusablePull(found) : null;

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
    if (created.reason === "noChanges") {
        if (merged) {
            await deps.record(session.id, merged);
            return { kind: "existing", pull: merged };
        }
        return { kind: "refused", reason: "noChanges" };
    }
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
// ---------------------------------------------------------------------------
// The pull request tab: timeline, reply, merge, claim
//
// Ported from frontend/src/renderer/components/PRActions.tsx (when merge is
// offered), backend/internal/adapters/scm/github/merge_action.go (the merge
// guarded by the head commit that was read) and
// backend/internal/service/session/claim_pr.go (claiming an existing pull
// request) of Agent Orchestrator (Apache-2.0, commit e4ded08c6f15).
// ---------------------------------------------------------------------------

/** The token a pull request is read, merged or commented on with: the person's
 *  own linked GitHub account when they have one, so GitHub holds them to their
 *  own permissions on the repository, else the App installation. */
export async function pullRequestToken(userId: string, owner: string): Promise<string | null> {
    return (
        (await githubTokenForUser(userId, owner).catch(() => null)) ??
        (await github.githubAppInstallationToken(owner).catch(() => null))
    );
}

/** Why the merge button is not offered, as a code the page words itself. */
export type MergeBlock = "notOpen" | "readOnly" | "draft" | "conflicts" | "behind" | "protected";

/**
 * Whether GitHub would refuse a merge right now, from its own merge state
 * (GraphQL `mergeStateStatus` or REST `mergeable_state`, any case). Only what
 * GitHub itself reports as blocking disables the button: an unknown or
 * unstable state leaves the decision to GitHub, which enforces branch
 * protection on the merge call either way.
 */
export function mergeBlock(input: {
    state: "open" | "closed" | "merged" | null;
    draft: boolean;
    mergeState: string;
    push: string | null;
}): MergeBlock | null {
    if (input.state !== "open") return "notOpen";
    if (input.push === "disabled") return "readOnly";
    const state = input.mergeState.trim().toUpperCase();
    if (input.draft || state === "DRAFT") return "draft";
    if (state === "DIRTY") return "conflicts";
    if (state === "BEHIND") return "behind";
    if (state === "BLOCKED") return "protected";
    return null;
}

/** A pull request a person named: `12`, `#12`, or its GitHub link. */
export type PullRef = { number: number; repoFullName: string | null };

const PULL_PATH = /^\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,9})(?:\/.*)?$/;

export function parsePullRef(raw: string): PullRef | null {
    const ref = raw.trim().replace(/^#/, "");
    if (/^\d{1,9}$/.test(ref)) {
        const number = Number(ref);
        return number > 0 ? { number, repoFullName: null } : null;
    }
    let url: URL;
    try {
        url = new URL(ref);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const match = PULL_PATH.exec(url.pathname);
    if (!match) return null;
    const number = Number(match[3]);
    return number > 0 ? { number, repoFullName: `${match[1]}/${match[2]}` } : null;
}

export const CLAIM_REFUSALS = [
    "ended",
    "workspace",
    "invalid",
    "otherRepo",
    "noAuth",
    "missing",
    "notOpen",
    "taken"
] as const;
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number];

export type ClaimSession = Pick<SessionView, "id" | "repoFullName" | "state" | "pullRequest">;

export interface ClaimDeps {
    token: (owner: string) => Promise<string | null>;
    read: (
        owner: string,
        repo: string,
        number: number,
        token: string
    ) => Promise<github.BranchPullRequest | null>;
    /** Other live sessions of the same repository that link this number. */
    holders: (sessionId: string, number: number) => Promise<string[]>;
    record: (
        session: ClaimSession,
        pull: github.BranchPullRequest,
        takeFrom: readonly string[]
    ) => Promise<void>;
}

export type ClaimResult =
    | { kind: "claimed"; pull: github.BranchPullRequest; takenFrom: string[] }
    | { kind: "refused"; reason: ClaimRefusal };

/**
 * Attaches an existing pull request to a session, the way AO's `claim-pr`
 * does: same repository only, open ones only (a draft is open work), and never
 * silently away from another live session - that takes `takeover`.
 *
 * The session's branch is left as it is, as AO leaves its workspace: the
 * session's pull request becomes this one for its status, checks and merge.
 */
export async function claimSessionPullRequest(
    session: ClaimSession,
    raw: string,
    options: { takeover: boolean },
    deps: ClaimDeps
): Promise<ClaimResult> {
    if (core.isSessionOver(session.state)) return { kind: "refused", reason: "ended" };
    if (!session.repoFullName) return { kind: "refused", reason: "workspace" };
    const ref = parsePullRef(raw);
    if (!ref) return { kind: "refused", reason: "invalid" };
    if (ref.repoFullName && ref.repoFullName.toLowerCase() !== session.repoFullName.toLowerCase())
        return { kind: "refused", reason: "otherRepo" };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await deps.token(owner);
    if (!token) return { kind: "refused", reason: "noAuth" };
    const pull = await deps.read(owner, repo, ref.number, token);
    if (!pull) return { kind: "refused", reason: "missing" };
    if (pull.state !== "open") return { kind: "refused", reason: "notOpen" };
    if (session.pullRequest?.number === pull.number) return { kind: "claimed", pull, takenFrom: [] };
    const holders = await deps.holders(session.id, pull.number);
    if (holders.length > 0 && !options.takeover) return { kind: "refused", reason: "taken" };
    await deps.record(session, pull, holders);
    return { kind: "claimed", pull, takenFrom: holders };
}

/** The most live sessions a claim looks through for another holder. */
const HOLDERS_CAP = 20;

export function claimDeps(userId: string): ClaimDeps {
    return {
        token: (owner) => pullRequestToken(userId, owner),
        read: (owner, repo, number, token) => github.readPullRequest(owner, repo, number, token),
        holders: async (sessionId, number) => {
            const own = await prisma.agentSession.findUnique({
                where: { id: sessionId },
                select: { repoId: true }
            });
            if (!own?.repoId) return [];
            const rows = await prisma.agentSession.findMany({
                // Live ones only: an ended session holds nothing worth asking about.
                where: {
                    repoId: own.repoId,
                    prNumber: number,
                    id: { not: sessionId },
                    state: { notIn: ["stopped", "failed"] }
                },
                select: { id: true },
                orderBy: { createdAt: "desc" },
                take: HOLDERS_CAP
            });
            return rows.map((row) => row.id);
        },
        record: async (session, pull, takeFrom) => {
            const previous = session.pullRequest?.number ?? null;
            const others = [...takeFrom];
            await prisma.$transaction([
                ...(others.length
                    ? [
                          prisma.agentSession.updateMany({
                              where: { id: { in: others }, prNumber: pull.number },
                              data: { prNumber: null, prUrl: null }
                          }),
                          prisma.sessionPullFacts.deleteMany({
                              where: { sessionId: { in: others }, number: pull.number }
                          })
                      ]
                    : []),
                // The pull request the session linked before is no longer its own,
                // so its facts no longer speak for the session's status.
                ...(previous !== null && previous !== pull.number
                    ? [
                          prisma.sessionPullFacts.deleteMany({
                              where: { sessionId: session.id, number: previous }
                          })
                      ]
                    : []),
                prisma.agentSession.update({
                    where: { id: session.id },
                    data: { prNumber: pull.number, prUrl: pull.url },
                    select: { id: true }
                })
            ]);
            await prFacts.seedPullFacts(session.id, session.repoFullName, pull.number, pull.url);
            timelines.forgetTimeline(session.id);
            for (const id of others) timelines.forgetTimeline(id);
        }
    };
}

export type TimelineAnswer =
    | { kind: "timeline"; timeline: timelines.PullTimeline }
    | { kind: "none" }
    | { kind: "noAuth" }
    | { kind: "unreachable" };

/**
 * The session's pull request's timeline: from the few-second cache when it is
 * fresh, else from GitHub, refreshing the stored facts with the same answer.
 */
export async function sessionPullTimeline(
    session: Pick<SessionView, "id" | "repoFullName" | "pullRequest">,
    userId: string,
    options: { fresh?: boolean } = {}
): Promise<TimelineAnswer> {
    if (!session.pullRequest || !session.repoFullName) return { kind: "none" };
    const number = session.pullRequest.number;
    if (!options.fresh) {
        const hit = timelines.cachedTimeline(session.id, number);
        if (hit) return { kind: "timeline", timeline: hit };
    }
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await pullRequestToken(userId, owner);
    if (!token) return { kind: "noAuth" };
    const outcome = await timelines.fetchPullTimeline(owner, repo, number, token);
    if (outcome.kind !== "ok" || outcome.timeline.number !== number) return { kind: "unreachable" };
    timelines.rememberTimeline(session.id, outcome.timeline);
    await prFacts
        .writePullFacts(session.id, session.repoFullName, outcome.observation)
        .catch((error) => console.error("polaris: pull request facts could not be stored:", error));
    return { kind: "timeline", timeline: outcome.timeline };
}

export type ReplyResult =
    | { ok: true }
    | { ok: false; reason: "noPull" | "noAuth" | "unknownThread" | "notAllowed" | "limited" | "failed"; message?: string };

/**
 * Posts on the session's pull request: a reply in one of its review threads,
 * or a comment on its conversation. A thread is only replied to when this
 * pull request's own timeline has it, so an id from anywhere else is refused
 * here rather than posted wherever the token reaches.
 */
export async function replyOnSessionPull(
    session: Pick<SessionView, "id" | "repoFullName" | "pullRequest">,
    userId: string,
    input: { body: string; threadId?: string }
): Promise<ReplyResult> {
    if (!session.pullRequest || !session.repoFullName) return { ok: false, reason: "noPull" };
    const [owner, repo] = session.repoFullName.split("/") as [string, string];
    const token = await pullRequestToken(userId, owner);
    if (!token) return { ok: false, reason: "noAuth" };
    if (input.threadId) {
        const answer = await sessionPullTimeline(session, userId);
        const known =
            answer.kind === "timeline" &&
            answer.timeline.entries.some((entry) => entry.kind === "thread" && entry.id === input.threadId);
        if (!known) return { ok: false, reason: "unknownThread" };
        const result = await timelines.replyToReviewThread(input.threadId, input.body, token);
        timelines.forgetTimeline(session.id);
        return result;
    }
    const posted = await github.commentOnIssue(owner, repo, session.pullRequest.number, input.body, token);
    timelines.forgetTimeline(session.id);
    return posted ? { ok: true } : { ok: false, reason: "failed" };
}
