/**
 * The record of what ran.
 *
 * A row is written before anything is dispatched, not when a run reports in. A
 * dispatch GitHub refuses, a workflow that never starts and a container that dies
 * on boot are all things somebody has to be able to see, and none of them would
 * write their own row.
 *
 * The run's callback token is minted here and returned exactly once, to the
 * caller that is about to hand it to the runtime. Only its hash is stored.
 */

import { prisma } from "@polaris/db";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { parseGateSteps, type GateStepReport } from "@/lib/agents/agent-gate";
import {
    isTerminalRunState,
    type AgentExecution,
    type AgentRunState,
    type AgentTrigger
} from "@polaris/core";

/** How long a run may sit unfinished before the sweep gives up on it. Generous:
 *  the runtime's own ceiling is an hour by default and a queued job can wait for
 *  a free runner well beyond that. */
const RUN_STALE_MS = 6 * 60 * 60 * 1000;

export interface AgentRunView {
    id: string;
    repoId: string;
    repoFullName: string;
    trigger: AgentTrigger;
    execution: AgentExecution;
    state: AgentRunState;
    mode: string | null;
    model: string;
    issueNumber: number | null;
    prNumber: number | null;
    githubRunId: string | null;
    containerId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    tokensIn: number | null;
    tokensOut: number | null;
    error: string | null;
    /** What the Enigma quality gate reported, in the order it worked through the
     *  steps. Empty until a run reaches its push. */
    gateSteps: GateStepReport[];
    createdAt: Date;
}

interface RunRow {
    id: string;
    repoId: string;
    trigger: string;
    execution: string;
    state: string;
    mode: string | null;
    model: string;
    issueNumber: number | null;
    prNumber: number | null;
    githubRunId: string | null;
    containerId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    tokensIn: number | null;
    tokensOut: number | null;
    error: string | null;
    gateSteps: string | null;
    createdAt: Date;
    repo: { repoFullName: string };
}

function toView(row: RunRow): AgentRunView {
    return {
        id: row.id,
        repoId: row.repoId,
        repoFullName: row.repo.repoFullName,
        trigger: row.trigger as AgentTrigger,
        execution: row.execution as AgentExecution,
        state: row.state as AgentRunState,
        mode: row.mode,
        model: row.model,
        issueNumber: row.issueNumber,
        prNumber: row.prNumber,
        githubRunId: row.githubRunId,
        containerId: row.containerId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        error: row.error,
        gateSteps: parseGateSteps(row.gateSteps),
        createdAt: row.createdAt
    };
}

export interface ListRunsInput {
    repoFullName?: string | undefined;
    state?: AgentRunState | undefined;
    trigger?: AgentTrigger | undefined;
    limit?: number | undefined;
}

export async function listAgentRuns(ownerId: string, input: ListRunsInput = {}): Promise<AgentRunView[]> {
    const rows = await prisma.agentRun.findMany({
        where: {
            repo: { ownerId, ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}) },
            ...(input.state ? { state: input.state } : {}),
            ...(input.trigger ? { trigger: input.trigger } : {})
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(input.limit ?? 50, 200),
        include: { repo: { select: { repoFullName: true } } }
    });
    return rows.map(toView);
}

export async function getAgentRun(ownerId: string, runId: string): Promise<AgentRunView | null> {
    const row = await prisma.agentRun.findFirst({
        where: { id: runId, repo: { ownerId } },
        include: { repo: { select: { repoFullName: true } } }
    });
    return row ? toView(row) : null;
}

export interface CreateRunInput {
    repoId: string;
    trigger: AgentTrigger;
    execution: AgentExecution;
    model: string;
    mode?: string | null;
    issueNumber?: number | null;
    prNumber?: number | null;
    startedById?: string | null;
    /** What the agent is being asked to do, kept so a retry on the next model in
     *  the fallback chain asks the same thing. */
    prompt?: string | null;
    /** Which try this is on that chain, and the run it followed. */
    attempt?: number;
    parentRunId?: string | null;
}

/**
 * Open a run and mint the token it will authenticate its callbacks with.
 *
 * The raw token is returned here and nowhere else. Callers hand it straight to
 * whatever is about to run and never store it; what survives is the hash, so a
 * database dump cannot be replayed as a live run credential.
 */
export async function createAgentRun(input: CreateRunInput): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const row = await prisma.agentRun.create({
        data: {
            repoId: input.repoId,
            trigger: input.trigger,
            execution: input.execution,
            model: input.model,
            mode: input.mode ?? null,
            issueNumber: input.issueNumber ?? null,
            prNumber: input.prNumber ?? null,
            startedById: input.startedById ?? null,
            prompt: input.prompt ?? null,
            attempt: input.attempt ?? 1,
            parentRunId: input.parentRunId ?? null,
            tokenHash: hashToken(token),
            state: "queued"
        },
        select: { id: true }
    });
    return { id: row.id, token };
}

/**
 * Re-issue the token a run authenticates its later calls with, and return it.
 *
 * Called when a run asks for its context. The token minted at dispatch reaches
 * the container Polaris starts itself, but a GitHub-scheduled job has no safe
 * channel for one - a workflow input is readable by anybody who can see the
 * Actions tab. So the job proves itself with GitHub's OIDC assertion instead,
 * and collects its credential here, over TLS, in the reply.
 *
 * Rotating on every context fetch is deliberate: a run only asks once, so a
 * second fetch means either a retry, in which case the previous value was never
 * used, or something replaying the assertion, in which case the old token stops
 * working.
 */
export async function issueRunToken(runId: string): Promise<string> {
    const token = generateToken();
    await prisma.agentRun.update({ where: { id: runId }, data: { tokenHash: hashToken(token) } });
    return token;
}

/** Note that the run actually started, and where. */
export async function markRunStarted(runId: string, where: { githubRunId?: string; containerId?: string }): Promise<void> {
    await prisma.agentRun.updateMany({
        where: { id: runId, state: "queued" },
        data: {
            state: "running",
            startedAt: new Date(),
            ...(where.githubRunId ? { githubRunId: where.githubRunId } : {}),
            ...(where.containerId ? { containerId: where.containerId } : {})
        }
    });
}

export interface FinishRunInput {
    state: Extract<AgentRunState, "succeeded" | "failed" | "cancelled">;
    error?: string | null;
    result?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    /** Which classification the failure landed on, as a value. What decides
     *  whether the next model in the fallback chain is worth trying. */
    failureKind?: string | null;
}

/**
 * Close a run out.
 *
 * Guarded on the run not already being terminal, because three things can reach
 * this first and they race by design: the runtime reporting in, the
 * `workflow_run.completed` webhook, and the sweep below. Whichever arrives first
 * is the truth; a later one must not overwrite a real outcome with a guess.
 *
 * The token is cleared at the same time. Nothing legitimate calls back after a
 * run ends, and leaving it live would leave a credential lying around for as long
 * as the row exists.
 */
export async function finishAgentRun(runId: string, input: FinishRunInput): Promise<boolean> {
    const { count } = await prisma.agentRun.updateMany({
        where: { id: runId, state: { in: ["queued", "running"] } },
        data: {
            state: input.state,
            finishedAt: new Date(),
            tokenHash: null,
            error: input.error ?? null,
            result: input.result ?? null,
            tokensIn: input.tokensIn ?? null,
            tokensOut: input.tokensOut ?? null,
            failureKind: input.failureKind ?? null
        }
    });
    return count > 0;
}

/**
 * Close out runs nothing ever reported back on.
 *
 * A run whose dispatch succeeded but whose job was cancelled at the GitHub end,
 * or whose container was killed with the box, leaves a row that says "running"
 * for ever. Left alone that is worse than a failure: the screen shows work in
 * progress that stopped hours ago, and the run's callback token stays live.
 */
export async function sweepStaleRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - RUN_STALE_MS);
    const { count } = await prisma.agentRun.updateMany({
        where: { state: { in: ["queued", "running"] }, createdAt: { lt: cutoff } },
        data: {
            state: "failed",
            finishedAt: new Date(),
            tokenHash: null,
            error: "The run stopped reporting and was closed out. Its logs, if any, are on the job it ran as."
        }
    });
    return count;
}

/** Whether this run can still be cancelled. */
export function isCancellable(state: AgentRunState): boolean {
    return !isTerminalRunState(state);
}
