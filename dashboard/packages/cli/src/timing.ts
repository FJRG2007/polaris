/**
 * Where a command's time goes, printed to stderr when `PLR_DEBUG=1`.
 *
 * Phases are the slow, separate things a command waits on: starting Node and
 * loading the bundle, reading the sign-in from the keychain, and each request.
 * Nothing is recorded unless the variable is set, and nothing secret is ever
 * part of a label - a request is named by its method, path and status only.
 */

import { performance } from "node:perf_hooks";

const entries: string[] = [];

/** Whether timings are being collected for this process. */
export function timing(): boolean {
    return process.env.PLR_DEBUG === "1";
}

/** Record one finished phase. */
export function mark(label: string, startedAt: number): void {
    if (timing()) entries.push(`${label} ${Math.round(performance.now() - startedAt)} ms`);
}

/** Time `work` as `label`, whether it succeeds or fails. */
export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!timing()) return work();
    const startedAt = performance.now();
    try {
        return await work();
    } finally {
        mark(label, startedAt);
    }
}

/** Everything recorded, with the time since the process started, then forgotten. */
export function timingReport(): string {
    if (!timing()) return "";
    const lines = [
        ...entries.splice(0),
        `total ${Math.round(performance.now())} ms since node started`
    ];
    return lines.map((entry) => `plr: timing: ${entry}\n`).join("");
}
