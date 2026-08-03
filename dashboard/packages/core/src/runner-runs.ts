/**
 * How a run reads, once it is over.
 *
 * A runner row carries three separate facts - what state it ended in, whether
 * the guard refused the job, and whether it was ever given one - and what
 * somebody wants to know is a single word covering all three. Deriving that word
 * rather than storing a fourth column keeps the three from drifting apart from
 * their own summary.
 *
 * It lives here, in the pure layer, because both halves of the screen need it:
 * the server builds the list and the browser filters it, and a copy on each side
 * would be two definitions of "turned down".
 */

/** What became of a job, in the terms somebody reading the list is asking in. */
export const RUNNER_RUN_OUTCOMES = ["ran", "running", "refused", "failed"] as const;
export type RunnerRunOutcome = (typeof RUNNER_RUN_OUTCOMES)[number];

/** The three columns the outcome is read from. */
export interface RunnerRunSignals {
    /** starting | idle | busy | finished | failed, as the runner row holds it. */
    readonly state: string;
    /** Why the guard would not let the job run, or null. */
    readonly refusedReason: string | null;
}

/**
 * Which outcome a row belongs to.
 *
 * The refusal is checked first on purpose. A refused job ends as a runner that
 * was given work and turned it down, which every other reading of those columns
 * would call something else - and "turned down, here is the rule" is the whole
 * reason somebody opened the list.
 */
export function outcomeOf(run: RunnerRunSignals): RunnerRunOutcome {
    if (run.refusedReason) return "refused";
    if (run.state === "failed") return "failed";
    if (run.state === "starting" || run.state === "idle" || run.state === "busy") return "running";
    return "ran";
}
