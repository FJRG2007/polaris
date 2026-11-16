/**
 * "Preparing this computer": where a runner stands installing the tools a
 * session on it needs (`toolchain.progress`), kept for the session screen.
 *
 * Held in every node's process for as long as a start takes: the node the
 * runner's socket reached records it and publishes it on the runner bus
 * (`computer-bus.ts`), and a node that serves a session screen listens from
 * its first read (`listenForComputerProgress`). The screen reads it through
 * `sessionScreenAction`.
 *
 * The runner sends machine words only; `toolchainEndDetail` turns the
 * `session.ended` detail a failed preparation carries into the reader's
 * sentence. Server-only.
 */

import * as core from "@polaris/core";
import type { LiveNotice } from "./computer-bus";

export interface ComputerProgress {
    readonly tool: string;
    readonly step: (typeof core.TOOLCHAIN_STEPS)[number];
    readonly received?: number;
    readonly total?: number;
    readonly code?: (typeof core.TOOLCHAIN_FAILURES)[number];
}

/** How long a progress line is kept without a newer one. */
const KEEP_MS = 10 * 60_000;
/** Most sessions held at once, so a flood cannot grow it without bound. */
const MAX_HELD = 2000;

const held = new Map<string, { progress: ComputerProgress; at: number }>();

export function recordComputerProgress(sessionId: string, progress: ComputerProgress, now = Date.now()): void {
    // Deleted first so the newest is last, and the oldest goes first below.
    held.delete(sessionId);
    held.set(sessionId, { progress, at: now });
    while (held.size > MAX_HELD) held.delete(held.keys().next().value!);
}

export function computerProgress(sessionId: string, now = Date.now()): ComputerProgress | null {
    const entry = held.get(sessionId);
    if (!entry) return null;
    if (now - entry.at > KEEP_MS) {
        held.delete(sessionId);
        return null;
    }
    return entry.progress;
}

export function forgetComputerProgress(sessionId: string): void {
    held.delete(sessionId);
}

/** Another node's progress notice, kept like one of this node's own. */
export function receiveProgressNotice(notice: LiveNotice): void {
    if (notice.k === "progress") recordComputerProgress(notice.sessionId, notice.progress);
}

/**
 * The failure a runner ended a session with (`toolchain:<tool>:<code>`,
 * `git:<step>`, `cli:<reason>`, `workspace:<reason>`), as the words to show.
 * Anything else is passed through unchanged: an older desktop's sentence.
 */
export function toolchainEndDetail(
    detail: string | null | undefined,
    words: { failure: (code: (typeof core.TOOLCHAIN_FAILURES)[number]) => string; other: string }
): string | null {
    if (!detail) return null;
    const match = /^toolchain:[a-z0-9-]+:([a-z]+)$/.exec(detail);
    if (match) {
        const code = match[1] as (typeof core.TOOLCHAIN_FAILURES)[number];
        return (core.TOOLCHAIN_FAILURES as readonly string[]).includes(code) ? words.failure(code) : words.other;
    }
    if (/^(git|cli|workspace):[a-z-]+$/.test(detail) || detail === "start") return words.other;
    return detail;
}
