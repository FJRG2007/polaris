/**
 * The subagents running in this process: each one's stop switch, the steering
 * messages waiting for its next step, and the per-person ceiling.
 *
 * Owner-scoped like `runs.ts`: every stop and steer names the user, and one
 * that is not theirs answers as if nothing ran.
 */

import { SUBAGENTS_MAX } from "@/lib/polar/subagents/shared";

interface LiveSubagent {
    userId: string;
    threadId: string;
    controller: AbortController;
    steers: string[];
}

const store = globalThis as typeof globalThis & { __polarSubagents?: Map<string, LiveSubagent> };
// enigma: one process holds them, as `runs.ts` does - Polaris runs one web container.
const live: Map<string, LiveSubagent> = (store.__polarSubagents ??= new Map());

/** Most steering messages held for one subagent between two steps. */
const STEERS_HELD = 10;

/** How many subagents this person has running now. */
export function runningCount(userId: string): number {
    let count = 0;
    for (const entry of live.values()) if (entry.userId === userId) count += 1;
    return count;
}

/**
 * Takes a place for a subagent, or null when the person already has as many
 * running as one person may. The signal aborts on its stop, on the parent's
 * (`parent`, for one the parent waits on), and never otherwise.
 */
export function admitSubagent(
    id: string,
    userId: string,
    threadId: string,
    parent?: AbortSignal
): AbortController | null {
    if (runningCount(userId) >= SUBAGENTS_MAX) return null;
    const controller = new AbortController();
    if (parent) {
        if (parent.aborted) controller.abort();
        else parent.addEventListener("abort", () => controller.abort(), { once: true });
    }
    live.set(id, { userId, threadId, controller, steers: [] });
    return controller;
}

/** Gives the place back once the run has ended. */
export function releaseSubagent(id: string): void {
    live.delete(id);
}

export function isRunning(id: string): boolean {
    return live.has(id);
}

/** Stops one of the person's running subagents; false when none was theirs. */
export function stopSubagent(userId: string, id: string): boolean {
    const entry = live.get(id);
    if (!entry || entry.userId !== userId) return false;
    entry.controller.abort();
    return true;
}

/** Stops every subagent the person has running in a chat. */
export function stopThreadSubagents(userId: string, threadId: string): number {
    let stopped = 0;
    for (const entry of live.values()) {
        if (entry.userId !== userId || entry.threadId !== threadId) continue;
        entry.controller.abort();
        stopped += 1;
    }
    return stopped;
}

/** Queues a message for a running subagent's next step; false when it is not running. */
export function steerSubagent(userId: string, id: string, text: string): boolean {
    const entry = live.get(id);
    if (!entry || entry.userId !== userId || entry.controller.signal.aborted) return false;
    if (entry.steers.length >= STEERS_HELD) return false;
    entry.steers.push(text);
    return true;
}

/** The steering messages waiting for a subagent, taken out of the queue. */
export function takeSteers(id: string): string[] {
    const entry = live.get(id);
    if (!entry || entry.steers.length === 0) return [];
    return entry.steers.splice(0);
}

/** Test seam: forgets every subagent. */
export function resetSubagents(): void {
    live.clear();
}
