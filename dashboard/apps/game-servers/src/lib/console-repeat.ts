/**
 * A console command run several times with a pause between the runs: "give
 * everybody a piglin, ten times, every five seconds".
 *
 * Not a schedule. A schedule is stored on the install and fired by the minute
 * sweep, so it outlives the dashboard and cannot run finer than a minute. A
 * repeat is the other end: seconds apart, minutes long at most, and held in the
 * dashboard's memory while it runs (`console-repeat-jobs`), so a dashboard that
 * restarts simply has none - there is nothing stored to come back half-done.
 *
 * Pure: the limits, the schema both sides check a repeat with, and the shape
 * the console is shown. Safe to import from the browser.
 */

import { z } from "zod";
import { gameMessage } from "./game-message";

/** The units a gap is typed in. Seconds are the point of this; minutes are for
 *  the longer gaps, which would be awkward to type in seconds. */
export const REPEAT_UNITS = ["seconds", "minutes"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

/** Fewer than two is one run, which is what Run already does. */
export const MIN_REPEAT_TIMES = 2;
export const MAX_REPEAT_TIMES = 100;
/** The shortest gap: a server is not to be driven faster than once a second. */
export const MIN_REPEAT_GAP_MS = 1_000;
/** The longest a whole repeat may span, first run to last. */
export const MAX_REPEAT_SPAN_MS = 6 * 60 * 60 * 1_000;
/** Repeats running at once on one server, and on the whole dashboard. */
export const MAX_REPEATS_PER_SERVER = 3;
export const MAX_REPEATS_OVERALL = 50;

const UNIT_MS: Readonly<Record<RepeatUnit, number>> = { seconds: 1_000, minutes: 60_000 };

/** How many runs, and the gap between them, as typed. */
export interface RepeatPlan {
    readonly times: number;
    readonly every: number;
    readonly unit: RepeatUnit;
}

export function repeatGapMs(plan: Pick<RepeatPlan, "every" | "unit">): number {
    return plan.every * UNIT_MS[plan.unit];
}

/** How long a repeat takes from its first run to its last. */
export function repeatSpanMs(plan: RepeatPlan): number {
    return repeatGapMs(plan) * (plan.times - 1);
}

const timesMessage = () =>
    gameMessage("games", "consoleRepeat.errors.times", {
        min: MIN_REPEAT_TIMES,
        max: MAX_REPEAT_TIMES
    });
const everyMessage = () => gameMessage("games", "consoleRepeat.errors.every");

/** One repeat, checked the same way by the dialog as it is typed and by the
 *  server before anything runs. */
export const repeatPlanSchema = z
    .object({
        times: z
            .number({ invalid_type_error: timesMessage() })
            .int(timesMessage())
            .min(MIN_REPEAT_TIMES, timesMessage())
            .max(MAX_REPEAT_TIMES, timesMessage()),
        every: z
            .number({ invalid_type_error: everyMessage() })
            .int(everyMessage())
            .min(1, everyMessage()),
        unit: z.enum(REPEAT_UNITS)
    })
    .strict()
    .superRefine((plan, context) => {
        if (repeatGapMs(plan) < MIN_REPEAT_GAP_MS) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: everyMessage() });
        } else if (repeatSpanMs(plan) > MAX_REPEAT_SPAN_MS) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: gameMessage("games", "consoleRepeat.errors.tooLong", {
                    hours: MAX_REPEAT_SPAN_MS / 3_600_000
                })
            });
        }
    });

/** What is wrong with a repeat as typed, as a carried message, or null. */
export function repeatPlanProblem(plan: RepeatPlan): string | null {
    const checked = repeatPlanSchema.safeParse(plan);
    return checked.success ? null : (checked.error.issues[0]?.message ?? null);
}

/** Why a repeat ended before its last run. */
export type RepeatEnd = "finished" | "stopped" | "serverStopped" | "noAccess";

/** One repeat as the console shows it, to anybody with the console. */
export interface ConsoleRepeatView {
    readonly id: string;
    /** The kept command's name, or the line typed. */
    readonly label: string;
    readonly command: string;
    readonly done: number;
    readonly total: number;
    readonly gapMs: number;
    /** When the next run is due, epoch ms; null while one is running or once it ended. */
    readonly nextAt: number | null;
    readonly startedBy: string;
    /** Null while it runs. */
    readonly ended: RepeatEnd | null;
    /** What the last run that went wrong said, as a carried message. */
    readonly lastProblem: string | null;
}
