/**
 * Telling a server that will never start from one that is merely slow.
 *
 * From outside they are the same thing: a container that is up, a game that is not
 * answering, and a panel that says "starting". A first boot genuinely takes real
 * minutes - the image fetches its own jar and every plugin before the world is
 * even opened - so waiting is not evidence, and the wait is exactly what a boot
 * loop hides behind. A server that crashed, restarted, crashed again and will do
 * that until somebody looks at it reported the same word, forever.
 *
 * Two questions, answered by two different sources, which is the whole design:
 *
 * - **Is it looping?** The engine already knows. It counts restarts and records
 *   when the current run began, and both come back in the inspect Polaris makes
 *   anyway. No log parsing, no history table, and nothing game specific - a rule
 *   about a container is a rule every game gets.
 * - **Why?** That is in the log, and only in the log. A crashed Java server prints
 *   thousands of stack frames around one line that says what actually went wrong,
 *   and finding that line is most of what this file does.
 *
 * Pure and synchronous on purpose: the reading is somebody else's job, so this is
 * testable against a captured log without a container anywhere near it.
 */

import { stripFormatting } from "@/lib/apps/minecraft/parse";

/** What a server is doing when it will not start, and what to do about it. */
export interface CrashLoop {
    /** How many times the engine has restarted it. */
    readonly restarts: number;
    /** The line that explains it, when one could be found. */
    readonly cause: string | null;
    /** What to do about it, for the causes worth knowing by name. */
    readonly advice: string | null;
}

/** The container state this rule reads, which is the part of an inspect that
 *  says anything about restarting. */
export interface RestartFacts {
    readonly status: string;
    readonly restartCount: number;
    readonly startedAt?: string | undefined;
    readonly restarting?: boolean | undefined;
}

/**
 * Restarts before it counts as a loop.
 *
 * Two would be enough to be suspicious and three is enough to be sure. A server
 * restarted once by an operator pressing the button, or twice while its machine
 * came back from a reboot, is not a server with a problem - and the cost of being
 * wrong here is stopping a server somebody is waiting on.
 */
const MIN_RESTARTS = 3;

/**
 * How young the current run has to be for the count to still mean something.
 *
 * The count is cumulative for the life of the container, so on its own it says
 * nothing: a server that crash-looped for an hour last month and has been up ever
 * since carries the same number as one crashing right now. Two minutes is
 * comfortably longer than the gap between two crashes and comfortably shorter than
 * a first boot that is fetching a jar and a world, so a run older than this is a
 * run that got somewhere.
 */
const LOOP_UPTIME_MS = 120_000;

/**
 * Whether this container is restarting in a loop rather than starting slowly.
 *
 * The `restarting` flag is a straight yes when it happens to be true, but it is
 * only set while the engine waits out its backoff - a second or two between runs,
 * which a poll almost never lands in. It corroborates; the count and the clock
 * decide.
 */
export function isCrashLooping(state: RestartFacts, now: Date): boolean {
    if (state.restarting === true) return true;
    if (state.restartCount < MIN_RESTARTS) return false;
    const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    // A start time the daemon did not give, or gave as its zero value, is not
    // evidence of a young run - so the count alone never convicts.
    if (Number.isNaN(started) || started <= 0) return false;
    return now.getTime() - started < LOOP_UPTIME_MS;
}

/** Lines that are the shape of the trace rather than the content of it. */
const STACK_FRAME = /^(?:at\s+\S|\.{3}\s+\d+\s+more$|Suppressed:\s)/;

/** A fully qualified exception, with whatever it was thrown with. */
const THROWN = /((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error))(?::\s*(.*))?$/;

/** The prefixes a line collects on the way here: docker's timestamp, then the
 *  game's own clock and level. */
const LOG_PREFIX = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+)?(?:\[[\d:]{5,8}\s+[A-Z]+\]:?\s*)?/;

/** As long as a cause is allowed to be on a status card. The rest is the console
 *  screen's job. */
const CAUSE_MAX = 200;

/**
 * The line that says why the server died, out of everything it printed dying.
 *
 * Four passes, weakest last, and the order is the point:
 *
 * 1. The deepest `Caused by:`. Java prints the outer exception first and each
 *    cause under the last, so the final one in the file is the root - the
 *    difference between "failed to initialize world defaults" and "for input
 *    string: default", which is the half somebody can act on.
 * 2. Any thrown exception, for a crash that had no chain.
 * 3. The last error line that is not a frame, which is what makes this work for a
 *    server whose crashes are not Java at all.
 *
 * Stack frames are dropped before any of it. That is the step the plain startup
 * signal is missing, and why it answers a crash like this one with a line of
 * somebody else's library.
 */
export function crashCause(log: string): string | null {
    const lines = stripFormatting(log)
        .split("\n")
        .map((line) => line.replace(LOG_PREFIX, "").trim())
        .filter((line) => line.length > 0 && !STACK_FRAME.test(line));

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        if (line.startsWith("Caused by:")) return shorten(line.slice("Caused by:".length).trim());
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (THROWN.test(lines[index] ?? "")) return shorten(lines[index] ?? "");
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        if (/\b(?:ERROR|FATAL)\b/.test(line)) return shorten(line);
    }
    return null;
}

/** The class without its package, and bounded. `java.lang.NumberFormatException`
 *  identifies nothing that `NumberFormatException` does not. */
function shorten(line: string): string {
    const trimmed = line.replace(THROWN, (_, thrown: string, detail?: string) => {
        const short = thrown.split(".").at(-1) ?? thrown;
        return detail ? `${short}: ${detail}` : short;
    });
    return trimmed.length > CAUSE_MAX ? `${trimmed.slice(0, CAUSE_MAX - 1).trimEnd()}...` : trimmed;
}

/**
 * What to do about the crashes worth knowing by name.
 *
 * Four, and it is meant to stay about four. Every entry has to earn itself by
 * being a failure whose message does not already say what to do, and a table that
 * grows past what anyone maintains is a table that starts giving wrong advice.
 * Anything unrecognised gets null and the cause line stands on its own, which is
 * already far better than the panel saying "starting".
 */
export function crashAdvice(cause: string): string | null {
    if (/NumberFormatException/.test(cause) && /"default"/.test(cause)) {
        return "The settings on disk were written by a newer Minecraft than this server now runs, and it cannot read them. Setting them aside lets the server write its own again.";
    }
    if (/AccessDenied/i.test(cause) && /session\.lock/i.test(cause)) {
        return "The server is not allowed to write into its own world folder, so it cannot claim the world.";
    }
    if (/Address already in use|FAILED TO BIND/i.test(cause)) {
        return "Something else already holds the port this server was given.";
    }
    if (/OutOfMemoryError|heap space/i.test(cause)) {
        return "The server ran out of memory for what it has been asked to load. Give it a larger heap or install less.";
    }
    return null;
}

/** The whole reading, for a container that has been judged to be looping. */
export function crashLoopOf(state: RestartFacts, log: string): CrashLoop {
    const cause = crashCause(log);
    return { restarts: state.restartCount, cause, advice: cause ? crashAdvice(cause) : null };
}
