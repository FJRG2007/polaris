/**
 * Starting and finishing reviewer passes (`session-reviewer.ts`): the store,
 * the container engine and the session's queue behind one set of deps, so the
 * orchestration is tested with all of them mocked.
 *
 * Nothing here blocks or fails the session: a pass is started after the pull
 * request facts are stored, and its result is collected by the sweep, never
 * awaited by a turn. Every entry point catches and logs.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { Prisma } from "@polaris/db";
import * as reviewer from "@/lib/agents/session-reviewer";
import { AGENT_HOME, CONTAINER_USER } from "@/lib/agents/session-commands";

export interface ReviewerSession {
    state: string;
    ownerId: string | null;
    hostId: string | null;
    sharedHome: boolean;
    autoFeedback: boolean;
    repoFullName: string | null;
    reviewer: { cli: string; model: string | null } | null;
}

export interface ReviewerPull {
    state: string;
    draft: boolean;
    headSha: string;
    targetBranch: string;
}

export interface RunningReview {
    id: string;
    sessionId: string;
    number: number;
    hostId: string | null;
    startedAt: Date;
}

export interface ReviewerDeps {
    now(): number;
    session(sessionId: string): Promise<ReviewerSession | null>;
    pull(sessionId: string, number: number): Promise<ReviewerPull | null>;
    runs(sessionId: string, number: number): Promise<reviewer.PlanRun[]>;
    /** Opens the row; null when another trigger opened the same try first. */
    create(row: {
        sessionId: string;
        number: number;
        headSha: string;
        attempt: number;
        trigger: reviewer.ReviewTrigger;
        cli: string;
        model: string | null;
        hostId: string | null;
    }): Promise<string | null>;
    /** A read-only clone header for the repository, or null. */
    cloneAuth(repoFullName: string): Promise<string | null>;
    credentials(ownerId: string, cli: core.AgentCli): Promise<Record<string, string> | null>;
    start(
        target: { hostId: string | null; ownerId: string; sharedHome: boolean },
        name: string,
        env: Record<string, string>
    ): Promise<void>;
    containerState(hostId: string | null, name: string): Promise<"running" | "stopped" | "gone">;
    logs(hostId: string | null, name: string): Promise<string>;
    remove(hostId: string | null, name: string): Promise<void>;
    /** Closes a running row; false when it was no longer running. */
    finish(
        id: string,
        data: {
            state: reviewer.ReviewState;
            verdict?: reviewer.ReviewVerdict | null;
            summary?: string | null;
            findings?: reviewer.ReviewFinding[];
            error?: string | null;
        }
    ): Promise<boolean>;
    running(limit: number): Promise<RunningReview[]>;
    words(ownerId: string): Promise<reviewer.ReviewerWords>;
    enqueue(sessionId: string, ownerId: string, key: string, text: string): Promise<boolean>;
    markFedBack(id: string): Promise<void>;
    deliver(sessionId: string): Promise<void>;
}

export type RequestOutcome = { started: true; reviewId: string } | { started: false; reason: string };

/**
 * Review the session's pull request at its current head, when the repository
 * names a reviewer and the plan says this head is due.
 */
export async function requestReview(
    input: { sessionId: string; number: number; trigger: reviewer.ReviewTrigger },
    deps: ReviewerDeps = defaultDeps()
): Promise<RequestOutcome> {
    try {
        const session = await deps.session(input.sessionId);
        if (!session?.ownerId || !session.repoFullName) return { started: false, reason: "session_not_found" };
        if (core.isSessionOver(session.state as core.AgentSessionState)) return { started: false, reason: "terminated" };
        const cli = reviewer.reviewerCli(session.reviewer?.cli);
        if (!cli) return { started: false, reason: "missing_reviewer" };
        const pull = await deps.pull(input.sessionId, input.number);
        if (!pull) return { started: false, reason: "no_pr" };
        const plan = reviewer.planReview(pull, await deps.runs(input.sessionId, input.number), input.trigger);
        if (!plan.start) return { started: false, reason: plan.reason };

        const model = session.reviewer?.model ?? null;
        const reviewId = await deps.create({
            sessionId: input.sessionId,
            number: input.number,
            headSha: pull.headSha,
            attempt: plan.attempt,
            trigger: input.trigger,
            cli: cli.id,
            model,
            hostId: session.hostId
        });
        if (!reviewId) return { started: false, reason: "review_running" };

        try {
            const auth = await deps.cloneAuth(session.repoFullName);
            if (!auth) throw new Error("Polaris has no GitHub access to this repository to check it out.");
            const credentials = await deps.credentials(session.ownerId, cli);
            if (credentials === null) throw new Error("Polaris could not read the stored credentials just now.");
            const env = reviewer.reviewerEnv(
                {
                    repoFullName: session.repoFullName,
                    number: input.number,
                    headSha: pull.headSha,
                    baseBranch: pull.targetBranch,
                    cli,
                    model,
                    auth,
                    credentials
                },
                { user: CONTAINER_USER, home: AGENT_HOME }
            );
            await deps.start(
                { hostId: session.hostId, ownerId: session.ownerId, sharedHome: session.sharedHome },
                reviewer.reviewContainerName(reviewId),
                env
            );
        } catch (error) {
            console.error(`[session-reviewer] ${input.sessionId}: the review could not start`, error);
            await deps.finish(reviewId, { state: "failed", error: "start_failed" });
            return { started: false, reason: "start_failed" };
        }
        return { started: true, reviewId };
    } catch (error) {
        console.error(`[session-reviewer] ${input.sessionId}: the review could not be planned`, error);
        return { started: false, reason: "error" };
    }
}

/**
 * Collect every finished pass: read what it printed, store the verdict,
 * remove its container, and queue requested changes to the session. A pass
 * past its timeout is stopped and failed; one whose container has not appeared
 * yet is left alone for a grace period. Returns how many were closed.
 */
export async function sweepReviews(deps: ReviewerDeps = defaultDeps()): Promise<number> {
    let closed = 0;
    const rows = await deps.running(reviewer.SWEEP_BATCH).catch(() => [] as RunningReview[]);
    for (const row of rows) {
        try {
            if (await collect(row, deps)) closed++;
        } catch (error) {
            console.error(`[session-reviewer] ${row.id}: the review could not be collected`, error);
        }
    }
    return closed;
}

async function collect(row: RunningReview, deps: ReviewerDeps): Promise<boolean> {
    const name = reviewer.reviewContainerName(row.id);
    const age = deps.now() - row.startedAt.getTime();
    const state = await deps.containerState(row.hostId, name).catch(() => "gone" as const);
    if (state === "running" && age < reviewer.REVIEW_TIMEOUT_MS) return false;
    if (state === "gone" && age < reviewer.START_GRACE_MS) return false;

    const output = state === "gone" ? "" : await deps.logs(row.hostId, name).catch(() => "");
    const result = state === "stopped" ? reviewer.parseReviewOutput(output) : null;
    await deps.remove(row.hostId, name).catch(() => undefined);
    if (!result) {
        const error = state === "running" ? "timed_out" : state === "gone" ? "container_gone" : "no_result";
        return deps.finish(row.id, { state: "failed", error });
    }
    const closed = await deps.finish(row.id, {
        state: "complete",
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings,
        error: null
    });
    if (closed) await feedBack(row, result, deps);
    return closed;
}

/** Requested changes reach the session as one queued message, under the same
 *  switch as the rest of its automatic feedback. */
async function feedBack(row: RunningReview, result: reviewer.ReviewResult, deps: ReviewerDeps): Promise<void> {
    if (result.verdict !== "changes_requested") return;
    const session = await deps.session(row.sessionId);
    if (!session?.ownerId || !session.autoFeedback) return;
    if (core.isSessionOver(session.state as core.AgentSessionState)) return;
    const text = reviewer.reviewerFeedbackPrompt(row.number, result, await deps.words(session.ownerId));
    if (!text) return;
    if (!(await deps.enqueue(row.sessionId, session.ownerId, `reviewer:${row.number}`, text))) return;
    await deps.markFedBack(row.id);
    if (core.isSessionListening(session.state as core.AgentSessionState)) await deps.deliver(row.sessionId);
}

// ---------------------------------------------------------------------------
// The real deps
// ---------------------------------------------------------------------------

function defaultDeps(): ReviewerDeps {
    return {
        now: () => Date.now(),
        session: async (sessionId) => {
            const row = await prisma.agentSession.findUnique({
                where: { id: sessionId },
                select: {
                    state: true,
                    hostId: true,
                    sharedHome: true,
                    autoFeedback: true,
                    startedById: true,
                    repo: {
                        select: { ownerId: true, repoFullName: true, sessionReviewer: true, sessionReviewerModel: true }
                    }
                }
            });
            if (!row) return null;
            return {
                state: row.state,
                hostId: row.hostId,
                sharedHome: row.sharedHome,
                autoFeedback: row.autoFeedback,
                ownerId: row.startedById ?? row.repo?.ownerId ?? null,
                repoFullName: row.repo?.repoFullName ?? null,
                reviewer: row.repo?.sessionReviewer
                    ? { cli: row.repo.sessionReviewer, model: row.repo.sessionReviewerModel }
                    : null
            };
        },
        pull: (sessionId, number) =>
            prisma.sessionPullFacts.findUnique({
                where: { sessionId_number: { sessionId, number } },
                select: { state: true, draft: true, headSha: true, targetBranch: true }
            }),
        runs: (sessionId, number) =>
            prisma.sessionReview.findMany({
                where: { sessionId, number },
                orderBy: { startedAt: "desc" },
                take: 50,
                select: { headSha: true, attempt: true, state: true, verdict: true, trigger: true }
            }),
        create: async (row) => {
            try {
                const created = await prisma.sessionReview.create({ data: row, select: { id: true } });
                return created.id;
            } catch (error) {
                if ((error as { code?: string }).code === "P2002") return null;
                throw error;
            }
        },
        cloneAuth: async (repoFullName) => {
            const github = await import("@/lib/github-service");
            const [owner, name] = repoFullName.split("/");
            if (!owner || !name) return null;
            // Read-only and this repository only: the one credential the
            // container gets for GitHub, dropped before the tool starts.
            const token = await github
                .githubAppInstallationToken(owner, { repositories: [name], permissions: { contents: "read" } })
                .catch(() => null);
            return github.cloneAuthHeader(token);
        },
        credentials: async (ownerId, cli) => {
            const [keys, readiness] = await Promise.all([
                import("@/lib/agents/model-keys"),
                import("@/lib/agents/agent-readiness")
            ]);
            const available = await keys.sessionSecretsFor(ownerId);
            return available === null ? null : readiness.sessionCredentials(cli, available, null, false);
        },
        start: async (target, name, env) => {
            const [commands, ports] = await Promise.all([
                import("@/lib/agents/session-commands"),
                import("@/lib/agents/session-ports")
            ]);
            // The tool's sign-in lives in the account's home, so it is the one
            // thing mounted. The worker's checkout is not.
            // Whose home is the one its sessions run on (`session-container.ts`).
            const home = target.sharedHome ? commands.SHARED_HOME_SOURCE : commands.agentHomeSource(target.ownerId);
            await ports.withContainerPorts(target.hostId, (engine) =>
                engine.composeUp({
                    project: name,
                    services: [
                        {
                            name,
                            image: commands.SESSION_IMAGE,
                            env,
                            ports: [],
                            volumes: [{ source: home, target: commands.AGENT_HOME, kind: "bind" as const }],
                            labels: { [reviewer.REVIEW_LABEL]: name },
                            command: commands.bootArgv(reviewer.reviewerScript(commands.AGENT_ACCOUNT_SETUP)),
                            networks: [],
                            // A pass exists once; the sweep collects it after it exits.
                            restart: "no"
                        }
                    ],
                    volumes: [],
                    networks: []
                })
            );
        },
        containerState: async (hostId, name) => {
            const ports = await import("@/lib/agents/session-ports");
            return ports.withContainerPorts(hostId, (engine) => ports.containerState(engine, name));
        },
        logs: async (hostId, name) => {
            const ports = await import("@/lib/agents/session-ports");
            let collected = "";
            await ports.withContainerPorts(hostId, (engine) =>
                engine.logs(
                    name,
                    (chunk) => {
                        if (collected.length < reviewer.OUTPUT_MAX + 4_096) collected += chunk.toString("utf8");
                    },
                    { tail: 5_000 }
                )
            );
            return collected;
        },
        remove: async (hostId, name) => {
            const ports = await import("@/lib/agents/session-ports");
            await ports.withContainerPorts(hostId, (engine) => engine.composeDown(name));
        },
        finish: async (id, data) => {
            const updated = await prisma.sessionReview.updateMany({
                where: { id, state: "running" },
                data: {
                    state: data.state,
                    verdict: data.verdict ?? null,
                    summary: data.summary ?? null,
                    findings: (data.findings ?? []) as unknown as Prisma.InputJsonValue,
                    error: data.error ?? null,
                    finishedAt: new Date()
                }
            });
            return updated.count > 0;
        },
        running: (limit) =>
            prisma.sessionReview.findMany({
                where: { state: "running" },
                orderBy: { startedAt: "asc" },
                take: limit,
                select: { id: true, sessionId: true, number: true, hostId: true, startedAt: true }
            }),
        words: async (ownerId) => {
            const { wordsFor } = await import("@/lib/notifications/notice-words");
            return (await wordsFor(ownerId, "agents")) as unknown as reviewer.ReviewerWords;
        },
        enqueue: async (sessionId, ownerId, key, text) => {
            const queue = await import("@/lib/agents/session-prompt-queue");
            return queue.queueFeedback(sessionId, ownerId, key, text);
        },
        markFedBack: async (id) => {
            await prisma.sessionReview.update({ where: { id }, data: { fedBack: true } });
        },
        deliver: async (sessionId) => {
            const queue = await import("@/lib/agents/session-prompt-queue");
            await queue.deliverNextQueued(sessionId);
        }
    };
}
