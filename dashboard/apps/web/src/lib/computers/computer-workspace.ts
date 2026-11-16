/**
 * Reads of a session's checkout on the person's own computer: its files, one
 * file, the changes and one diff - what a container session answers with
 * commands run in the container (`session-files.ts`, `session-review.ts`) -
 * and pieces of its transcript for the history (`transcript.read`, only to a
 * runner that announced `transcript-read`).
 *
 * The question goes to the runner as `workspace.read`, only to one that
 * announced `workspace-read`; a runner without it is answered with null here,
 * so the screens keep saying what they said before. The answer comes back as
 * `workspace.answer` on whichever node holds the runner's socket: delivered
 * here when this node asked, otherwise published on the runner bus for the
 * node that did. An answer is only taken from the runner it was asked of.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";
import { sendToRunner } from "./computer-commands";
import { onRunnerLive, publishRunnerLive, type LiveNotice } from "./computer-bus";

/** How long a read waits for the computer before it says it is unreachable. */
export const WORKSPACE_READ_TIMEOUT_MS = 15_000;
/** Reads one node waits on at once; past it a read is refused. */
const MAX_PENDING = 500;

type Read = "workspace" | "transcript";
type AnswerOf<K extends Read> = K extends "workspace" ? core.WorkspaceAnswer : core.TranscriptAnswer;

interface Pending {
    readonly runnerId: string;
    readonly kind: Read;
    readonly resolve: (answer: core.WorkspaceAnswer | core.TranscriptAnswer | null) => void;
}

const pending = new Map<string, Pending>();

export interface WorkspaceDeps {
    readonly features: (runnerId: string) => Promise<readonly string[] | null>;
    readonly send: (runnerId: string, command: core.ServerCommand) => Promise<boolean>;
    readonly listen: () => void;
    readonly timeoutMs?: number;
}

async function storedFeatures(runnerId: string): Promise<readonly string[] | null> {
    const row = await prisma.agentRunner.findUnique({ where: { id: runnerId }, select: { capabilities: true } });
    const features = (row?.capabilities as { features?: unknown } | null)?.features;
    return Array.isArray(features) ? features.filter((value): value is string => typeof value === "string") : null;
}

function receiveLive(notice: LiveNotice): void {
    if (notice.k === "workspace" || notice.k === "transcript") deliverLocal(notice.k, notice.runnerId, notice.requestId, notice.answer);
}

const defaults: WorkspaceDeps = {
    features: storedFeatures,
    send: sendToRunner,
    listen: () => onRunnerLive(receiveLive)
};

/** Whether this runner answers workspace reads. */
export async function runnerReadsWorkspace(runnerId: string, deps: WorkspaceDeps = defaults): Promise<boolean> {
    return (await deps.features(runnerId))?.includes("workspace-read") ?? false;
}

/** Send one read and wait for its answer: null when the runner lacks the
 *  feature, is not connected, or did not answer in time. */
async function ask<K extends Read>(
    kind: K,
    runnerId: string,
    feature: core.RunnerFeature,
    command: (requestId: string) => core.ServerCommand,
    deps: WorkspaceDeps
): Promise<AnswerOf<K> | null> {
    if (!((await deps.features(runnerId))?.includes(feature) ?? false)) return null;
    if (pending.size >= MAX_PENDING) return null;
    deps.listen();
    const requestId = randomUUID();
    const answer = new Promise<AnswerOf<K> | null>((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve(null);
        }, deps.timeoutMs ?? WORKSPACE_READ_TIMEOUT_MS);
        pending.set(requestId, {
            runnerId,
            kind,
            resolve: (value) => {
                clearTimeout(timer);
                pending.delete(requestId);
                resolve(value as AnswerOf<K> | null);
            }
        });
    });
    const sent = await deps.send(runnerId, command(requestId));
    if (!sent) pending.get(requestId)?.resolve(null);
    return answer;
}

/**
 * Ask the computer one question about a session's checkout. Null when the
 * runner cannot answer it (an older desktop), is not connected, or did not
 * answer in time.
 */
export async function readComputerWorkspace(
    session: { readonly id: string; readonly runnerId: string },
    query: core.WorkspaceQuery,
    deps: WorkspaceDeps = defaults
): Promise<core.WorkspaceAnswer | null> {
    return ask("workspace", session.runnerId, "workspace-read", (requestId) => ({ type: "workspace.read", requestId, sessionId: session.id, query }), deps);
}

/**
 * Ask the computer for one piece of a session's transcript at `path` (as its
 * hook reported it). Null on the same terms as `readComputerWorkspace`, for a
 * runner without `transcript-read`.
 */
export async function readComputerTranscript(
    session: { readonly id: string; readonly runnerId: string },
    path: string,
    query: core.TranscriptQuery,
    deps: WorkspaceDeps = defaults
): Promise<core.TranscriptAnswer | null> {
    return ask("transcript", session.runnerId, "transcript-read", (requestId) => ({ type: "transcript.read", requestId, sessionId: session.id, path, query }), deps);
}

function deliverLocal(kind: Read, runnerId: string, requestId: string, answer: core.WorkspaceAnswer | core.TranscriptAnswer): boolean {
    const waiting = pending.get(requestId);
    if (!waiting || waiting.runnerId !== runnerId || waiting.kind !== kind) return false;
    waiting.resolve(answer);
    return true;
}

/** A runner's `workspace.answer`: to the read waiting here, or to the other
 *  nodes when none is. */
export function deliverWorkspaceAnswer(
    runnerId: string,
    requestId: string,
    answer: core.WorkspaceAnswer,
    publish: (notice: LiveNotice) => Promise<void> = publishRunnerLive
): boolean {
    if (deliverLocal("workspace", runnerId, requestId, answer)) return true;
    if (!pending.has(requestId)) void publish({ k: "workspace", runnerId, requestId, answer });
    return false;
}

/** A runner's `transcript.answer`, delivered like a workspace answer. */
export function deliverTranscriptAnswer(
    runnerId: string,
    requestId: string,
    answer: core.TranscriptAnswer,
    publish: (notice: LiveNotice) => Promise<void> = publishRunnerLive
): boolean {
    if (deliverLocal("transcript", runnerId, requestId, answer)) return true;
    if (!pending.has(requestId)) void publish({ k: "transcript", runnerId, requestId, answer });
    return false;
}

/** The runner of a live session placed on a computer, or null. */
export async function computerSessionRunner(sessionId: string): Promise<string | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { place: true, runnerId: true, state: true }
    });
    if (!row || row.place !== "computer" || !row.runnerId) return null;
    return core.isSessionOver(row.state as core.AgentSessionState) ? null : row.runnerId;
}
