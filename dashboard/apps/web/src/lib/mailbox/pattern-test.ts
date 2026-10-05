/**
 * A filter's pattern, run on the server with a time limit.
 *
 * The schema refuses the patterns that are known to run away (see
 * `mailPatternProblem`), but "known" is a heuristic and this runs on every
 * message that arrives, so the server does not rely on it alone: each run gets
 * a few milliseconds and a pattern that has not answered by then has not
 * matched. JavaScript cannot stop a regular expression from inside, so the run
 * happens in a `vm` context whose timeout interrupts it.
 *
 * One context, reused: creating one per run costs more than the run.
 */

import vm from "node:vm";
import type * as core from "@polaris/core";

/** Long enough for any pattern worth writing over the bounded text it gets;
 *  short enough that a mailbox's worth of them cannot hold up a sync. */
const PATTERN_MS = 25;

const context = vm.createContext({ pattern: "", text: "", found: false });
const run = new vm.Script("found = new RegExp(pattern, 'i').test(text);");

export const timedPatternTest: core.MailPatternTest = (pattern, text) => {
    context.pattern = pattern;
    context.text = text;
    context.found = false;
    try {
        run.runInContext(context, { timeout: PATTERN_MS });
        return context.found === true;
    } catch (caught) {
        // Out of time, or a pattern this engine refuses. Either way, no match.
        console.warn("polaris: a mail filter pattern was given up on:", (caught as Error).message);
        return false;
    }
};
