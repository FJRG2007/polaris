/**
 * Where an announcement stands at a given moment, worked out from its dates.
 *
 * Nothing stores the phase: a rescheduled window or an early end is right on the
 * next read everywhere, and the clock that sends the step notices compares this
 * against the last phase it announced. Pure, so it is tested without a clock.
 * Client-safe.
 */

export type Phase =
    /** Not showing yet: an announcement set for later, or maintenance before its lead. */
    | "scheduled"
    /** An announcement that is showing. */
    | "live"
    /** Maintenance announced and counting down. */
    | "upcoming"
    | "inProgress"
    /** Maintenance over; said for a while, then it ends. */
    | "finished"
    | "ended"
    | "retracted";

/** How long "maintenance finished" stays up after the window closes. */
export const FINISHED_SHOWN_MS = 2 * 60 * 60_000;

export interface PhaseInput {
    kind: string;
    startsAt: Date;
    endsAt: Date | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    retractedAt: Date | null;
}

export function phaseAt(item: PhaseInput, now: Date): Phase {
    if (item.retractedAt) return "retracted";
    const at = now.getTime();
    if (item.kind === "maintenance" && item.windowStart && item.windowEnd) {
        if (at < item.startsAt.getTime()) return "scheduled";
        if (at < item.windowStart.getTime()) return "upcoming";
        if (at < item.windowEnd.getTime()) return "inProgress";
        if (at < item.windowEnd.getTime() + FINISHED_SHOWN_MS) return "finished";
        return "ended";
    }
    if (at < item.startsAt.getTime()) return "scheduled";
    if (item.endsAt && at >= item.endsAt.getTime()) return "ended";
    return "live";
}

const SHOWING: ReadonlySet<Phase> = new Set(["live", "upcoming", "inProgress", "finished"]);

/** Whether the banner is up in this phase, before audience and dismissal. */
export function bannerShowing(phase: Phase): boolean {
    return SHOWING.has(phase);
}

/**
 * A critical message stays until it is over. Anything else can be closed, maintenance
 * under way included: closing it hides it for this phase only, so it is back once the
 * maintenance is finished.
 */
export function bannerDismissible(severity: string): boolean {
    return severity !== "critical";
}

/** A banner closed in an earlier phase comes back when the phase changes. */
export function bannerHidden(
    phase: Phase,
    dismissedPhase: string | null | undefined,
    severity: string
): boolean {
    return dismissedPhase === phase && bannerDismissible(severity);
}

/**
 * Whether the clock owes a notice now, and for which phase.
 *
 * The first notice goes out when the item first shows. Later steps of a
 * maintenance window only when the administrator asked for them. Never twice
 * for the same phase, and never for a phase already behind: a window the server
 * slept through is announced once, as what it is now.
 */
export function noticeDue(input: {
    phase: Phase;
    noticedPhase: string | null;
    sendNotice: boolean;
    notifySteps: boolean;
}): Phase | null {
    if (!input.sendNotice || !bannerShowing(input.phase)) return null;
    if (input.noticedPhase === input.phase) return null;
    if (input.noticedPhase === null) return input.phase;
    return input.notifySteps ? input.phase : null;
}

/** Severity as the bell colours it. */
export function levelFor(severity: string): "info" | "success" | "warning" | "danger" {
    if (severity === "critical") return "danger";
    if (severity === "success" || severity === "warning") return severity;
    return "info";
}

/** Milliseconds until the phase next changes, or null when it never will. */
export function nextChangeIn(item: PhaseInput, now: Date): number | null {
    const at = now.getTime();
    const edges = [
        item.startsAt,
        item.endsAt,
        item.windowStart,
        item.windowEnd,
        item.windowEnd ? new Date(item.windowEnd.getTime() + FINISHED_SHOWN_MS) : null
    ]
        .filter((edge): edge is Date => edge !== null && edge.getTime() > at)
        .map((edge) => edge.getTime() - at);
    return edges.length > 0 ? Math.min(...edges) : null;
}

/** A tab never waits longer than this to read its banners again by itself. */
export const REREAD_MAX_MS = 6 * 60 * 60_000;
/** Read just after a boundary rather than on it, so the server already agrees. */
export const REREAD_SLACK_MS = 1000;

/** How long a tab waits before reading its banners again, given the next change. */
export function rereadDelay(nextChangeInMs: number | null): number {
    if (nextChangeInMs === null) return REREAD_MAX_MS;
    return Math.min(Math.max(nextChangeInMs, 0) + REREAD_SLACK_MS, REREAD_MAX_MS);
}
