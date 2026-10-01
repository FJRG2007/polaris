/**
 * Connectivity outages: what one is, how a pass of the address watcher moves it,
 * and how a list of them adds up.
 *
 * Pure, and safe to import from the browser: the tracker that writes rows
 * (`outage-tracker.ts`) and the screen that reads them both decide from here, so
 * the rule that closes an outage and the sum that says how long it lasted cannot
 * drift apart.
 *
 * The watcher already tells three situations apart before it alerts anybody, and
 * an outage keeps the same three:
 *
 * - `line`: nothing answered, and the public resolvers Polaris checks were
 *   silent too. The connection is down, not the address.
 * - `dns`: the line works, and the public address's name did not resolve.
 * - `address`: the line works, the name resolves (or the failure said nothing
 *   about it), and the public address did not answer - the edge, the port
 *   forward, a moved IP.
 *
 * An outage carries the worst of them it went through, so one that started as a
 * silent address and turned into a dead line is counted once, as the line.
 */

import { z } from "zod";
import { wallClock, zonedInstant } from "@polaris/core";

export const OUTAGE_KINDS = ["line", "dns", "address"] as const;
export type OutageKind = (typeof OUTAGE_KINDS)[number];

const SEVERITY: Record<OutageKind, number> = { address: 0, dns: 1, line: 2 };

/** The worse of two kinds. */
export function worseKind(a: OutageKind, b: OutageKind): OutageKind {
    return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function isOutageKind(value: unknown): value is OutageKind {
    return typeof value === "string" && (OUTAGE_KINDS as readonly string[]).includes(value);
}

/** What `firstBack` holds when the resolvers answered before the address did. */
export const BACK_VIA_INTERNET = "internet";

/** Failure codes that mean the name did not resolve, as opposed to nothing answering. */
const NAME_FAILURES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]);

/** One address as a pass probed it. */
export interface ProbeResult {
    readonly host: string;
    readonly up: boolean;
    /** The probe's words, "Timed out", "HTTP 502". */
    readonly detail: string | null;
    /** The network error code behind a failure, when there was one. */
    readonly code: string | null;
}

/** What a whole pass says about this deployment's connection. */
export type Observation =
    | { readonly up: true; readonly via: string }
    | {
          readonly up: false;
          readonly kind: OutageKind;
          readonly detectedBy: string | null;
          readonly detail: string | null;
      };

/**
 * Fold one pass into a single verdict.
 *
 * Any address answering is up: the box is reachable from outside, which is the
 * question. A listed address that is dead while another answers is that
 * address's problem, reported on its own by the watcher, and not an outage of the
 * deployment - otherwise one stale domain would read as a year without internet.
 *
 * `internet` is the resolvers' answer, asked only when nothing else answered;
 * null means it was not asked, and with no address to go on that is no verdict.
 * `listed` is how many addresses the pass set out to check: when some were listed
 * but none produced a result, a working line says nothing about them either.
 */
export function observe(
    results: readonly ProbeResult[],
    internet: boolean | null,
    listed: number = results.length
): Observation | null {
    const answered = results.find((result) => result.up);
    if (answered) return { up: true, via: answered.host };
    if (internet === null) return null;
    const first = results[0] ?? null;
    if (!internet) {
        return {
            up: false,
            kind: "line",
            detectedBy: first?.host ?? null,
            detail: first?.detail ?? null
        };
    }
    if (!first) return listed > 0 ? null : { up: true, via: BACK_VIA_INTERNET };
    const unresolved = results.every(
        (result) => result.code !== null && NAME_FAILURES.has(result.code)
    );
    return {
        up: false,
        kind: unresolved ? "dns" : "address",
        detectedBy: first.host,
        detail: first.code && unresolved ? first.code : first.detail
    };
}

/** An outage as the tracker decides from it, times in epoch milliseconds. */
export interface OutageSnapshot {
    readonly id: string;
    readonly kind: OutageKind;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly lastSeenAt: number;
    readonly firstBack: string | null;
    readonly closedBy: string | null;
}

export interface TrackerInput {
    /** The ongoing outage, if one is open. */
    readonly open: OutageSnapshot | null;
    /** The most recently ended one, for merging a blip into it. */
    readonly last: OutageSnapshot | null;
    readonly observation: Observation;
    readonly now: number;
    /** Outages closer than this are one outage. */
    readonly mergeGapMs: number;
    /** A gap between passes longer than this means Polaris was not watching. */
    readonly staleMs: number;
    /** When a pass last found everything answering. */
    readonly lastUpAt: number | null;
}

export type TrackerStep =
    | {
          readonly do: "open";
          readonly kind: OutageKind;
          readonly at: number;
          readonly lastUpAt: number | null;
          readonly detectedBy: string | null;
          readonly detail: string | null;
      }
    | {
          readonly do: "continue";
          readonly id: string;
          readonly kind: OutageKind;
          readonly at: number;
          readonly firstBack: string | null;
      }
    | {
          readonly do: "close";
          readonly id: string;
          readonly at: number;
          readonly closedBy: "recovered" | "unobserved";
          readonly firstBack: string | null;
      }
    | {
          readonly do: "reopen";
          readonly id: string;
          /** The end being undone, so a second container doing the same finds nothing. */
          readonly endedAt: number;
          readonly kind: OutageKind;
          readonly at: number;
      };

/** Whether an open outage's last sighting is recent enough to still be followed. */
function watched(open: OutageSnapshot, now: number, staleMs: number): boolean {
    return now - open.lastSeenAt <= staleMs;
}

/**
 * What one pass does to the record.
 *
 * Three rules beyond the obvious open-and-close:
 *
 * - **A restart.** The open row survives Polaris stopping. If the next pass comes
 *   within `staleMs` of the last one that saw it down, nothing was missed and it
 *   simply continues - a redeploy mid-outage is one outage, not two. Past that,
 *   nobody was watching: it is closed at the last moment it was actually seen
 *   down (`unobserved`), and if the line is still down a new one starts now.
 *   Time nobody measured is never counted as downtime, and the row is never left
 *   open forever.
 * - **Flapping.** Down again within `mergeGapMs` of a recovery is the same outage
 *   coming back, so the ended one is reopened rather than a second one counted.
 *   Only one that recovered: an `unobserved` end is not a recovery anybody saw.
 * - **What came back first.** A dead line whose resolvers answer again while the
 *   address is still silent records `internet` as first back; otherwise the host
 *   that answered is.
 */
export function nextSteps(input: TrackerInput): TrackerStep[] {
    const { open, last, observation, now, mergeGapMs, staleMs, lastUpAt } = input;
    const steps: TrackerStep[] = [];
    let current = open;

    if (current && !watched(current, now, staleMs)) {
        steps.push({
            do: "close",
            id: current.id,
            at: current.lastSeenAt,
            closedBy: "unobserved",
            firstBack: current.firstBack
        });
        current = null;
    }

    if (observation.up) {
        if (current) {
            steps.push({
                do: "close",
                id: current.id,
                at: now,
                closedBy: "recovered",
                firstBack: current.firstBack ?? observation.via
            });
        }
        return steps;
    }

    if (current) {
        const lineBack =
            current.kind === "line" && observation.kind !== "line" && current.firstBack === null;
        steps.push({
            do: "continue",
            id: current.id,
            kind: worseKind(current.kind, observation.kind),
            at: now,
            firstBack: lineBack ? BACK_VIA_INTERNET : current.firstBack
        });
        return steps;
    }

    // Only when nothing was closed this pass: a stale outage closed a moment ago
    // is not a recovery to merge into.
    if (
        steps.length === 0 &&
        last &&
        last.endedAt !== null &&
        last.closedBy === "recovered" &&
        now - last.endedAt <= mergeGapMs
    ) {
        steps.push({
            do: "reopen",
            id: last.id,
            endedAt: last.endedAt,
            kind: worseKind(last.kind, observation.kind),
            at: now
        });
        return steps;
    }

    steps.push({
        do: "open",
        kind: observation.kind,
        at: now,
        lastUpAt,
        detectedBy: observation.detectedBy,
        detail: observation.detail
    });
    return steps;
}

/**
 * Whether the watcher should look again soon rather than at its usual pace: while
 * something is down, so the end is measured to the half-minute rather than to the
 * ten, and for the merge window after a recovery, so a blip back down is seen.
 */
export function watchClosely(
    open: Pick<OutageSnapshot, "endedAt"> | null,
    last: Pick<OutageSnapshot, "endedAt" | "closedBy"> | null,
    now: number,
    mergeGapMs: number
): boolean {
    if (open && open.endedAt === null) return true;
    return (
        last !== null &&
        last.endedAt !== null &&
        last.closedBy === "recovered" &&
        now - last.endedAt < mergeGapMs
    );
}

/** The span an outage covers, as numbers. */
export interface OutageSpan {
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly lastSeenAt: number;
}

/**
 * Where an outage ends for counting. An ended one at its end; an ongoing one now,
 * while it is still being watched; one whose watcher went quiet at the last time
 * it was seen down, which is all that is known.
 */
export function effectiveEnd(outage: OutageSpan, now: number, staleMs: number): number {
    if (outage.endedAt !== null) return outage.endedAt;
    return now - outage.lastSeenAt <= staleMs ? now : outage.lastSeenAt;
}

export interface PeriodSummary {
    /** Where counting started: the period's start, or when tracking began if later. */
    readonly from: number;
    /** How much of the period was watched at all. */
    readonly observedMs: number;
    readonly downMs: number;
    readonly count: number;
    readonly longestMs: number;
    readonly averageMs: number;
    /** 0..1, or null when nothing of the period was watched yet. */
    readonly uptime: number | null;
}

/**
 * How one period went: the downtime inside it (an outage straddling its start
 * counts only the part inside), how many outages touched it, the longest and the
 * average of those parts, and the share of the watched time that was up.
 *
 * `since` is when tracking began. Before it nothing was measured, so it is not
 * counted as up either: a week-old install does not claim 90 days of 100%.
 */
export function summarizePeriod(
    outages: readonly OutageSpan[],
    now: number,
    periodMs: number,
    since: number | null,
    staleMs: number
): PeriodSummary {
    const from = Math.max(now - periodMs, since ?? Number.NEGATIVE_INFINITY);
    const observedMs = Math.max(0, now - from);
    let downMs = 0;
    let count = 0;
    let longestMs = 0;
    for (const outage of outages) {
        const start = Math.max(outage.startedAt, from);
        const end = Math.min(effectiveEnd(outage, now, staleMs), now);
        if (end < start || outage.startedAt > now) continue;
        if (end === start && outage.endedAt !== null) continue;
        const part = end - start;
        downMs += part;
        count += 1;
        longestMs = Math.max(longestMs, part);
    }
    return {
        from,
        observedMs,
        downMs,
        count,
        longestMs,
        averageMs: count > 0 ? Math.round(downMs / count) : 0,
        uptime: observedMs > 0 ? Math.max(0, 1 - downMs / observedMs) : null
    };
}

export interface DayDowntime {
    /** The calendar date in the reader's zone, YYYY-MM-DD. */
    readonly day: string;
    readonly start: number;
    /** The next midnight in the same zone: 23 or 25 hours on, on a clock change. */
    readonly end: number;
    readonly downMs: number;
    readonly count: number;
}

/**
 * Downtime per calendar day, oldest first, ending today. Days are cut in the
 * reader's own time zone - the one every date on the screen is shown in - so an
 * outage across midnight is split between the two days it touched.
 */
export function dailyDowntime(
    outages: readonly OutageSpan[],
    now: number,
    days: number,
    staleMs: number,
    timeZone: string
): DayDowntime[] {
    const today = wallClock(new Date(now), timeZone);
    const midnight = (back: number) => {
        // A calendar step, done on the date alone so a month or a year boundary is
        // not this function's problem, then placed at midnight in the zone.
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
        return {
            label: date.toISOString().slice(0, 10),
            at: zonedInstant(
                {
                    year: date.getUTCFullYear(),
                    month: date.getUTCMonth() + 1,
                    day: date.getUTCDate(),
                    hours: 0,
                    minutes: 0
                },
                timeZone
            ).getTime()
        };
    };
    const result: { -readonly [K in keyof DayDowntime]: DayDowntime[K] }[] = [];
    for (let back = days - 1; back >= 0; back -= 1) {
        const start = midnight(back);
        result.push({
            day: start.label,
            start: start.at,
            end: midnight(back - 1).at,
            downMs: 0,
            count: 0
        });
    }
    for (const outage of outages) {
        const outageEnd = Math.min(effectiveEnd(outage, now, staleMs), now);
        for (const day of result) {
            const part = Math.min(outageEnd, day.end) - Math.max(outage.startedAt, day.start);
            if (part > 0) {
                day.downMs += part;
                day.count += 1;
            }
        }
    }
    return result;
}

/**
 * The shade a day gets, 0 for no downtime and 1-4 for more. Steps a reader can
 * name - minutes, half an hour, hours - rather than a continuous ramp nobody can
 * read a number back out of.
 */
export const DAY_STEPS_MS = [5 * 60_000, 30 * 60_000, 3 * 3_600_000] as const;

export function dayStep(downMs: number): 0 | 1 | 2 | 3 | 4 {
    if (downMs <= 0) return 0;
    if (downMs < DAY_STEPS_MS[0]) return 1;
    if (downMs < DAY_STEPS_MS[1]) return 2;
    if (downMs < DAY_STEPS_MS[2]) return 3;
    return 4;
}

/** How a length of time is said, unit by unit, in whichever catalog the caller has. */
export type SpanWords = (
    form:
        | "seconds"
        | "minutes"
        | "minutesSeconds"
        | "hours"
        | "hoursMinutes"
        | "days"
        | "daysHours",
    values: { days?: number; hours?: number; minutes?: number; seconds?: number }
) => string;

/**
 * A duration in its two largest units: "45 s", "4 min 12 s", "3 h 5 min",
 * "2 d 4 h". Seconds stop being shown past ten minutes, where they are noise
 * against how precisely a pass can measure anything.
 */
export function formatSpan(ms: number, say: SpanWords): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return say("seconds", { seconds: total });
    const minutesTotal = Math.floor(total / 60);
    if (minutesTotal < 60) {
        const seconds = total % 60;
        return minutesTotal < 10 && seconds > 0
            ? say("minutesSeconds", { minutes: minutesTotal, seconds })
            : say("minutes", { minutes: minutesTotal });
    }
    const hoursTotal = Math.floor(minutesTotal / 60);
    if (hoursTotal < 24) {
        const minutes = minutesTotal % 60;
        return minutes > 0
            ? say("hoursMinutes", { hours: hoursTotal, minutes })
            : say("hours", { hours: hoursTotal });
    }
    const days = Math.floor(hoursTotal / 24);
    const hours = hoursTotal % 24;
    return hours > 0 ? say("daysHours", { days, hours }) : say("days", { days });
}

/** The merge gap when nobody has set one. */
export const DEFAULT_MERGE_GAP_SECONDS = 60;
/** The longest merge gap allowed: past an hour two outages are two outages. */
export const MAX_MERGE_GAP_SECONDS = 3600;

/** The merge gap as the form and the action both check it: whole seconds, 0 to an hour. */
export const mergeGapSchema = z.number().int().min(0).max(MAX_MERGE_GAP_SECONDS);

/** A stored merge gap, read back defensively: anything unusable is the default. */
export function storedMergeGap(value: string | null | undefined): number {
    const parsed = Number(value);
    if (value === null || value === undefined || value.trim() === "" || !Number.isInteger(parsed)) {
        return DEFAULT_MERGE_GAP_SECONDS;
    }
    return parsed >= 0 && parsed <= MAX_MERGE_GAP_SECONDS ? parsed : DEFAULT_MERGE_GAP_SECONDS;
}

/** How long outage rows are kept before they are folded into a month. */
export const OUTAGE_RETENTION_DAYS = 365;

/** The calendar month (UTC) an outage is filed under once it is rolled up. */
export function monthOf(time: number): string {
    const date = new Date(time);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
