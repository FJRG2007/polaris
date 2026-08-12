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

import { isPollNoise, stripFormatting } from "@/lib/apps/minecraft/parse";

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

/** What the count was the last time anybody looked, and when that was. */
export interface RestartWatch {
    readonly restartCount: number;
    /** ISO, and kept so a reading can be discarded rather than trusted forever. */
    readonly at: string;
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
 * Restarts that have to arrive *between two readings* before this convicts.
 *
 * The count and the clock together are still not enough, and a real server was
 * stopped mid-boot proving it. A container that looped, was repaired and is now
 * thirty seconds into a perfectly good run carries the same high count - the
 * engine never resets it - and the same young start time, because the run that
 * finally worked started when the last one died. From one sample the two are the
 * same server.
 *
 * What separates them is whether the number is still moving. A loop restarts every
 * few seconds and adds a dozen between two sweeps a minute apart; a server that got
 * up adds none, ever. Two is the smallest gap that cannot be one crash, and waiting
 * for the second costs a minute on a server that has already been broken for
 * however long nobody noticed.
 */
const LOOP_RESTARTS = 2;

/**
 * Whether this container is worth keeping an eye on: restarting often, on a run too
 * young to have got anywhere.
 *
 * Not a verdict, and nothing acts on it alone - it is the question `isCrashLooping`
 * answers by watching. The `restarting` flag belongs here for the same reason: it is
 * only set while the engine waits out its backoff, a second or two between runs that
 * a poll almost never lands in, so it corroborates rather than decides.
 */
export function watchesRestarts(state: RestartFacts, now: Date): boolean {
    if (state.restartCount < MIN_RESTARTS) return false;
    if (state.restarting === true) return true;
    const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    // A start time the daemon did not give, or gave as its zero value, is not
    // evidence of a young run - so the count alone never convicts.
    if (Number.isNaN(started) || started <= 0) return false;
    return now.getTime() - started < LOOP_UPTIME_MS;
}

/**
 * Whether this container is restarting in a loop rather than starting slowly.
 *
 * Two readings, because one cannot tell a loop from a recovery. `since` is what the
 * count was when Polaris last looked at a container that already looked suspicious;
 * with nothing to compare against this says no and the reading becomes the
 * comparison for the next one. Erring towards no is deliberate: the cost of a false
 * yes is stopping a server people are on, and the cost of a false no is a minute.
 */
export function isCrashLooping(state: RestartFacts, since: RestartWatch | null, now: Date): boolean {
    if (!watchesRestarts(state, now)) return false;
    if (since === null) return false;
    return state.restartCount - since.restartCount >= LOOP_RESTARTS;
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

/** What the container prints when a run begins. Every one of these is the image or
 *  the launcher rather than the game, which is why they arrive before it. */
const BOOT_MARKER = /^(?:\[init\]\s|\[mc-image-helper\]\s|Starting org\.bukkit\.craftbukkit\.Main)/;

/** And what the game prints once it is up and answering. Minecraft's, because it
 *  is the one that can be quoted from a real log; a game with no marker here simply
 *  never claims to have started, which is the reading everything already had. */
const READY_MARKER = /^Done \(\d[\d.]*s\)!/;

/** The log as a rule can read it: one line per line, without the prefixes it
 *  collected on the way here, and without the two kinds of line that are shape
 *  rather than content - the trace, and Polaris's own questions. */
function meaningfulLines(log: string): string[] {
    return stripFormatting(log)
        .split("\n")
        .map((line) => line.replace(LOG_PREFIX, "").trim())
        .filter((line) => line.length > 0 && !STACK_FRAME.test(line) && !isPollNoise(line));
}

/**
 * Whether the server got up on the run it is on now.
 *
 * The counters can say "looping" about a container that has just this second
 * recovered, and this is the log's answer to that: the ready line has to come after
 * the last time the container began booting, or it belongs to a run that has since
 * ended. A tail that does not reach back to a boot marker at all still counts, since
 * a server that printed it is one that answered.
 */
export function reachedReady(log: string): boolean {
    const lines = meaningfulLines(log);
    let boot = -1;
    let ready = -1;
    for (const [index, line] of lines.entries()) {
        if (BOOT_MARKER.test(line)) boot = index;
        if (READY_MARKER.test(line)) ready = index;
    }
    return ready > boot;
}

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
 *
 * Everything up to and including the last time the server announced it was up is
 * dropped too. A tail long enough to hold a stack trace is long enough to hold the
 * crash before last, and a run that ended in a working server explains nothing about
 * one that has not started yet - without this, a server that recovers keeps being
 * described by the failure it recovered from.
 */
export function crashCause(log: string): string | null {
    const all = meaningfulLines(log);
    let ready = -1;
    for (const [index, line] of all.entries()) if (READY_MARKER.test(line)) ready = index;
    const lines = ready === -1 ? all : all.slice(ready + 1);

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
    if (isConfigCrash(cause)) {
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

/**
 * Whether this is the crash a folder move fixes.
 *
 * The one failure Polaris can undo on its own, so it is a rule of its own rather
 * than a string match inside the advice: the screen offers the button on exactly
 * the crashes the advice claims it helps with, and neither can drift from the
 * other. A newer release wrote a sentinel where an older one wants a number, and
 * the older one throws while loading its own configuration.
 */
export function isConfigCrash(cause: string | null): boolean {
    return cause !== null && /NumberFormatException/.test(cause) && /"default"/.test(cause);
}

/** The whole reading, for a container that has been judged to be looping. */
export function crashLoopOf(state: RestartFacts, log: string): CrashLoop {
    const cause = crashCause(log);
    return { restarts: state.restartCount, cause, advice: cause ? crashAdvice(cause) : null };
}
