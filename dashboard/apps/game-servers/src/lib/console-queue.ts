/**
 * Several console lines, run one after another.
 *
 * What an operator actually does before a restart is a sequence: a title, a
 * subtitle, a freeze, a message, a pause, a "done" - and typing each of those
 * into a one-line box, waiting for it, and typing the next is the part nobody
 * wants to do while players are watching. So a block of lines is read into
 * steps here and the console runs them in order.
 *
 * Two kinds of step. A command is a line as it would have been typed. A pause is
 * a line of its own, `wait 10` or `wait 2.5s`, because the most common thing a
 * sequence needs between two commands is time: the freeze has to have worn off
 * before "done" means anything.
 *
 * Blank lines and lines starting with `#` are skipped, so a pasted block can
 * carry its own notes. A leading `/` is dropped the way the console drops it.
 *
 * Pure, so what a pasted block turns into can be asserted without a server.
 */

/** The longest single line the console sends: what the server-side guard takes
 *  in one argument, so the box never accepts a line the server would refuse. */
export const MAX_CONSOLE_LINE = 512;

/** One thing to do. */
export type QueueStep =
    | { readonly kind: "command"; readonly line: string }
    | { readonly kind: "wait"; readonly ms: number };

/** How many commands one block may hold. Enough for any sequence somebody writes
 *  by hand; a pasted log is not a sequence. */
export const MOST_QUEUED = 50;

/** The longest one pause may be. A sequence that needs longer is a schedule, and
 *  the Schedule tab is where those live. */
export const LONGEST_WAIT_S = 120;

/** A pause, as it is written on its own line. */
const WAIT = /^wait\s+(\d+(?:\.\d+)?)\s*s?$/i;

export interface ParsedQueue {
    readonly steps: readonly QueueStep[];
    /** What was wrong with the block, in words the operator can act on - or
     *  null when it can run. */
    readonly problem: string | null;
}

/** Read a block of lines into steps. */
export function parseQueue(text: string, maxLineLength: number): ParsedQueue {
    const steps: QueueStep[] = [];
    let commands = 0;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        const pause = WAIT.exec(line);
        if (pause) {
            const seconds = Number(pause[1]);
            if (seconds > LONGEST_WAIT_S) {
                return {
                    steps: [],
                    problem: `Line ${index + 1} waits longer than ${LONGEST_WAIT_S} seconds. Use the Schedule tab for that.`
                };
            }
            steps.push({ kind: "wait", ms: Math.round(seconds * 1000) });
            continue;
        }
        const command = line.replace(/^\//, "");
        if (command.length > maxLineLength) {
            return {
                steps: [],
                problem: `Line ${index + 1} is longer than the ${maxLineLength} characters the server takes in one command.`
            };
        }
        commands += 1;
        if (commands > MOST_QUEUED) {
            return {
                steps: [],
                problem: `That is more than ${MOST_QUEUED} commands. Split it into smaller runs.`
            };
        }
        steps.push({ kind: "command", line: command });
    }
    if (commands === 0) return { steps: [], problem: "There is no command in that." };
    return { steps, problem: null };
}

/** How many commands a parsed block will send, for the button that sends them. */
export function commandCount(steps: readonly QueueStep[]): number {
    return steps.filter((step) => step.kind === "command").length;
}
