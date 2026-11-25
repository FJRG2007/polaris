/**
 * How long this start took to reach each step, one line per start in
 * `<userData>/logs/startup.log`, so a slow start at sign-in can be told apart
 * from a slow app: the process start's wall clock, then each step in
 * milliseconds after it.
 *
 * Imported first by `index.ts`, so `bundle` is the first line of the bundle to
 * run. Marking is a number in a map; the file is read and written once, after
 * the first window has drawn, and never throws. Nothing personal goes in: no
 * address, no path, no account.
 */

import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** The most lines the file keeps: the newest starts. */
export const STARTUP_LOG_LINES = 200;

export const STARTUP_STEPS = ["bundle", "ready", "tray", "window", "painted", "shown"] as const;
export type StartupStep = (typeof STARTUP_STEPS)[number];

const marks = new Map<StartupStep, number>();
markStartup("bundle");

/** Remember when this start reached `step`; the first time counts. */
export function markStartup(step: StartupStep, at: number = performance.now()): void {
    if (!marks.has(step)) marks.set(step, at);
}

export function startupMarked(step: StartupStep): boolean {
    return marks.has(step);
}

export interface StartupRecord {
    /** The process start, in epoch milliseconds (`performance.timeOrigin`). */
    readonly origin: number;
    readonly version: string;
    /** Started by the computer at sign-in (`--hidden`), not by somebody. */
    readonly login: boolean;
    /** Milliseconds after the process start, per step reached. */
    readonly marks: ReadonlyMap<StartupStep, number>;
}

/** `2026-11-25T10:57:08.123Z 0.1.111 login bundle=+310 ready=+48012 ... shown=-`:
 *  a step not reached reads `-`. */
export function startupLine(record: StartupRecord): string {
    const steps = STARTUP_STEPS.map((step) => {
        const at = record.marks.get(step);
        return `${step}=${at === undefined ? "-" : `+${Math.round(at)}`}`;
    });
    return [new Date(record.origin).toISOString(), record.version, record.login ? "login" : "manual", ...steps].join(" ");
}

/** The file with `line` added, holding at most `max` lines. */
export function withLine(text: string, line: string, max: number = STARTUP_LOG_LINES): string {
    const lines = text.split(/\r?\n/).filter((kept) => kept.length > 0);
    lines.push(line);
    return `${lines.slice(-max).join("\n")}\n`;
}

/** Add `line` to the file at `path`, capped. Written beside and renamed over, so
 *  a failed write never leaves the log empty. */
export async function appendStartupLine(path: string, line: string, max: number = STARTUP_LOG_LINES): Promise<void> {
    const text = await readFile(path, "utf8").catch(() => "");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, withLine(text, line, max), "utf8");
    await rename(temporary, path);
}

let written = false;

/** Write this start's line, once. Never throws: a log is not worth a failure. */
export async function writeStartupLog(path: string, version: string, login: boolean): Promise<void> {
    if (written) return;
    written = true;
    try {
        await appendStartupLine(path, startupLine({ origin: performance.timeOrigin, version, login, marks }));
    } catch {
        // No log this time.
    }
}
