/**
 * Deciding which repository each of a pool's runners waits on, and when a
 * repository has had enough.
 *
 * A self-hosted runner is not a worker that pulls from a queue: it is registered
 * against one repository (or one organization) before it has any work, and GitHub
 * only hands it jobs from there. A pool with four slots and thirty repositories is
 * therefore choosing, at every moment, twenty-six repositories whose jobs will
 * wait. That choice is what this module makes.
 *
 * Three rules, in order:
 *
 *   1. Work that is already queued wins. A repository with a job waiting gets a
 *      runner before a repository that has nothing to do.
 *   2. A runner idling somewhere with no work is worth taking away to pay for one
 *      where there is work. Doing that is the difference between a queue and a
 *      lottery, and it is only ever an *idle* runner - a job in progress is never
 *      interrupted.
 *   3. Whatever is left over waits somewhere useful, spread so that the same few
 *      repositories do not keep every runner.
 *
 * All of it is pure. What a pool has running, what GitHub has queued and what each
 * repository has already spent are read elsewhere and passed in, so the decision
 * can be exercised without a machine or a GitHub account.
 */

/** How long a consumption budget runs before it starts over. */
export const RUNNER_WINDOWS = ["day", "month"] as const;
export type RunnerWindow = (typeof RUNNER_WINDOWS)[number];

/** What to do with a repository that has spent its budget. Pausing means its jobs
 *  queue on GitHub until the window turns over; warning means it keeps being served
 *  and the pool says it went over. */
export const RUNNER_EXHAUSTED_ACTIONS = ["pause", "warn"] as const;
export type RunnerExhaustedAction = (typeof RUNNER_EXHAUSTED_ACTIONS)[number];

/**
 * What one pool will spend, per repository it serves. Null is "no limit of this
 * kind" rather than zero, which would mean the opposite.
 *
 * Every limit is per target, not per pool: the pool's own ceiling is its
 * concurrency, which is bounded by what the machine can carry. These exist to stop
 * one repository from being the only one that gets served.
 */
export interface RunnerLimits {
    /** Jobs one repository may run at once inside this pool. */
    readonly perTargetConcurrent: number | null;
    /** Minutes of runner time one repository may spend per window. */
    readonly minutesBudget: number | null;
    readonly minutesWindow: RunnerWindow;
    /** Jobs one repository may start per day. */
    readonly jobsPerDay: number | null;
    readonly onExhausted: RunnerExhaustedAction;
}

export const NO_RUNNER_LIMITS: RunnerLimits = {
    perTargetConcurrent: null,
    minutesBudget: null,
    minutesWindow: "month",
    jobsPerDay: null,
    onExhausted: "pause"
};

/** Ceilings a form may ask for. Generous, because the machine's own capacity is
 *  the real bound; these only exist so a typo cannot store something absurd. */
export const MAX_MINUTES_BUDGET = 1_000_000;
export const MAX_JOBS_PER_DAY = 10_000;

/** What one repository has spent, measured from the runners this pool ran for it. */
export interface RunnerUsage {
    /** Minutes of runner time inside the minutes window. */
    readonly minutes: number;
    /** Jobs started since the start of today. */
    readonly jobsToday: number;
}

export interface BudgetVerdict {
    /** Whether a new runner may be started for this repository right now. */
    readonly allowed: boolean;
    /** Why it is over, in one line for the pool card. Null when it is within
     *  everything, whether or not there were limits to be within. */
    readonly exceeded: string | null;
}

/**
 * Whether a repository has anything left. A limit that is exceeded only stops it
 * when the pool was told to pause on exhaustion - `warn` reports the same sentence
 * and keeps serving, which is the honest reading of "tell me, do not block me".
 */
export function budgetVerdict(usage: RunnerUsage, limits: RunnerLimits): BudgetVerdict {
    const exceeded = firstExceeded(usage, limits);
    return { allowed: exceeded === null || limits.onExhausted === "warn", exceeded };
}

function firstExceeded(usage: RunnerUsage, limits: RunnerLimits): string | null {
    if (limits.minutesBudget !== null && usage.minutes >= limits.minutesBudget) {
        const window = limits.minutesWindow === "day" ? "today" : "this month";
        return `Used ${Math.floor(usage.minutes)} of ${limits.minutesBudget} minutes ${window}.`;
    }
    if (limits.jobsPerDay !== null && usage.jobsToday >= limits.jobsPerDay) {
        return `Ran ${usage.jobsToday} of ${limits.jobsPerDay} jobs allowed today.`;
    }
    return null;
}

/**
 * When the current window began, in UTC. Calendar boundaries rather than a rolling
 * period, so "this month" means the same thing to the operator reading the card as
 * it does to the pool refusing to start a runner.
 */
export function windowStart(window: RunnerWindow, now: Date): Date {
    return window === "day"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The start of today in UTC, which is the window every job count is kept over. */
export function dayStart(now: Date): Date {
    return windowStart("day", now);
}

/** One repository (or organization) a pool serves, as it stands right now. */
export interface TargetState {
    /** Identifies the target for the caller. `owner/repo`, or `owner` for an
     *  organization registration. Opaque here. */
    readonly key: string;
    /** Jobs GitHub has queued for it that this pool could take. */
    readonly queued: number;
    /** Runners this pool has up for it, busy ones included. */
    readonly live: number;
    /** Of those, the ones waiting with nothing to do. These are the only runners
     *  that can be taken away to fund work elsewhere. */
    readonly idle: number;
    /** Why it may not be served at all, from its budget. Null when it may. */
    readonly blocked: string | null;
    /** When this pool last started a runner for it, epoch milliseconds. Older is
     *  served first, which is what keeps one busy repository from holding every
     *  slot forever. 0 for a target that has never been served. */
    readonly lastServedAt: number;
}

export interface RunnerPlacement {
    /** Target keys to start a runner on, one entry per runner. */
    readonly start: readonly string[];
    /** Target keys to take one idle runner away from, one entry per runner. Each
     *  of these funds exactly one of the starts above. */
    readonly release: readonly string[];
}

export interface PlacementInput {
    /** Slots the pool has free right now: its concurrency minus what is running. */
    readonly free: number;
    readonly perTargetConcurrent: number | null;
    readonly targets: readonly TargetState[];
}

/**
 * Work out what to start and what to stand down.
 *
 * The result is a plan, not an action: nothing here knows whether starting a
 * runner will succeed, and a caller that manages only part of it leaves the rest
 * to the next pass rather than to a half-applied decision.
 */
export function placeRunners(input: PlacementInput): RunnerPlacement {
    const cap = input.perTargetConcurrent;
    const assigned = new Map<string, number>();
    const start: string[] = [];
    const release: string[] = [];
    let free = Math.max(0, input.free);

    const servable = input.targets.filter((target) => target.blocked === null);
    const held = (target: TargetState): number => target.live + (assigned.get(target.key) ?? 0);
    const roomFor = (target: TargetState): boolean => cap === null || held(target) < cap;
    /** Jobs queued for it that nothing is waiting to take. */
    const unmet = (target: TargetState): number => Math.max(0, target.queued - held(target));
    const take = (target: TargetState): void => {
        assigned.set(target.key, (assigned.get(target.key) ?? 0) + 1);
        start.push(target.key);
    };

    // Round-robin over whoever still has work nothing is waiting to take. One at a
    // time, re-sorted each turn, so eight queued jobs on one repository cannot
    // swallow the pool while another repository has one job and no runner.
    const byNeed = (a: TargetState, b: TargetState): number =>
        (assigned.get(a.key) ?? 0) - (assigned.get(b.key) ?? 0) ||
        a.lastServedAt - b.lastServedAt ||
        a.key.localeCompare(b.key);

    while (free > 0) {
        const next = servable.filter((target) => unmet(target) > 0 && roomFor(target)).sort(byNeed)[0];
        if (!next) break;
        take(next);
        free -= 1;
    }

    // Still queued work and no slots left: an idle runner sitting on a repository
    // with nothing to do is what it costs. Only idle ones, and only from targets
    // that are not themselves waiting on work.
    const idleElsewhere = servable
        .filter((target) => target.idle > 0 && unmet(target) === 0)
        .flatMap((target) => Array.from({ length: target.idle }, () => target))
        // The most over-served first: a target holding four idle runners gives one
        // up before a target holding its only one.
        .sort((a, b) => b.live - a.live || b.lastServedAt - a.lastServedAt || a.key.localeCompare(b.key));

    // A released runner is gone before its replacement starts, so what the donor
    // is counted as holding falls as it gives them up.
    for (const donor of idleElsewhere) {
        const waiting = servable.filter((target) => unmet(target) > 0 && roomFor(target)).sort(byNeed)[0];
        if (!waiting || waiting.key === donor.key) break;
        release.push(donor.key);
        assigned.set(donor.key, (assigned.get(donor.key) ?? 0) - 1);
        take(waiting);
    }

    // Nothing queued anywhere and slots to spare: leave them waiting somewhere
    // rather than idle in the pool, because a runner that is already up is the
    // difference between a job starting now and a job starting on the next pass.
    // Spread by who holds least, so a repository that was added later is not last
    // in line forever. A pool serving one repository gets all of them, which is
    // what a pool serving one repository has always done.
    while (free > 0) {
        const next = servable
            .filter(roomFor)
            .sort((a, b) => held(a) - held(b) || a.lastServedAt - b.lastServedAt || a.key.localeCompare(b.key))[0];
        if (!next) break;
        take(next);
        free -= 1;
    }

    return { start, release };
}
