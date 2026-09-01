/**
 * How long Polaris keeps the records it writes about people using it.
 *
 * Three tables grow forever and nothing ever read the old rows: the bell's
 * notifications, the activity log every screen writes to, and the audit trail.
 * On an instance that has been up a year that is the largest thing in the
 * database, and it is made almost entirely of lines nobody will ever open.
 *
 * The three are separate settings because they answer to different people. A
 * notification is a nudge and stops being useful the day after it arrives; an
 * activity line is how somebody works out what happened to a task last month; an
 * audit entry is what an operator reaches for when an account did something
 * nobody can account for, and it is the one an obligation is most likely to
 * attach to. Collapsing them into one number would mean setting all three to
 * whatever the longest of them has to be, which is the same as having no setting.
 *
 * Zero is forever, matching every other limit in Polaris - the alternative is a
 * sentinel that reads as "delete everything immediately" to anybody who has not
 * read this file.
 *
 * Pure: the screen offers exactly what the sweep enforces.
 */

import { z } from "zod";

/**
 * The periods on offer, in days.
 *
 * Real durations rather than a free number field. "How many days should Polaris
 * keep notifications" is a question with about six sensible answers, and a text
 * box invites the seventh - 45, 400, 3 - which nobody can justify later and which
 * makes two deployments impossible to compare.
 */
export const RETENTION_DAYS = [1, 7, 30, 90, 180, 365, 0] as const;
export type RetentionDays = (typeof RETENTION_DAYS)[number];

/** What each period is called, said the way somebody would say it out loud. */
export const RETENTION_LABELS: Record<RetentionDays, string> = {
    1: "A day",
    7: "A week",
    30: "30 days",
    90: "3 months",
    180: "6 months",
    365: "A year",
    0: "Forever"
};

/** The records a period can be set for. */
export const RETENTION_SUBJECTS = ["notifications", "activity", "audit"] as const;
export type RetentionSubject = (typeof RETENTION_SUBJECTS)[number];

export const RETENTION_SUBJECT_LABELS: Record<RetentionSubject, string> = {
    notifications: "Notifications",
    activity: "Activity",
    audit: "Audit log"
};

export const RETENTION_SUBJECT_NOTES: Record<RetentionSubject, string> = {
    notifications:
        "What arrives in the bell. A nudge is useful the day it lands and almost never after that, and this is the table that grows fastest.",
    activity:
        "What each screen records about the work on it - a status changed, a task moved, a server restarted. This is what somebody reads to work out what happened last month, so it is worth keeping longer than a nudge.",
    audit: "What was done with accounts, access and the deployment itself, and from which device. The one somebody reaches for when an account did something nobody can account for - set it to the longest period you are willing to hold."
};

/**
 * What an instance nobody has configured does.
 *
 * Thirty days for the bell, because that is roughly when a notification stops
 * being something anybody would scroll back to. A year for the other two, which
 * is long enough to answer "what happened" for any period somebody is likely to
 * ask about and short enough that the tables do not become the deployment.
 *
 * None of the three is Forever by default. A default that never deletes is a
 * default that quietly fills a disk on an instance whose operator never opened
 * this screen - which is every instance, until the day it matters.
 */
export const RETENTION_DEFAULTS: Record<RetentionSubject, RetentionDays> = {
    notifications: 30,
    activity: 365,
    audit: 365
};

/** Whether a number is one of the offered periods. Anything else - a value from
 *  a hand-made payload, a period dropped in a later release - reads as unset and
 *  falls back to the default. */
export function isRetentionDays(value: unknown): value is RetentionDays {
    return typeof value === "number" && (RETENTION_DAYS as readonly number[]).includes(value);
}

export const retentionPolicySchema = z.object({
    notifications: z.coerce.number().refine(isRetentionDays).default(RETENTION_DEFAULTS.notifications),
    activity: z.coerce.number().refine(isRetentionDays).default(RETENTION_DEFAULTS.activity),
    audit: z.coerce.number().refine(isRetentionDays).default(RETENTION_DEFAULTS.audit)
});

export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/**
 * The stored policy, or the defaults, never a throw.
 *
 * A setting written by an older build - or edited by hand - must open the screen
 * on the defaults rather than break it, and must never be read as "delete
 * everything": each field falls back on its own, so one bad number does not take
 * the other two with it.
 */
export function storedRetention(raw: string | null | undefined): RetentionPolicy {
    if (!raw) return { ...RETENTION_DEFAULTS };
    try {
        const parsed = retentionPolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : { ...RETENTION_DEFAULTS };
    } catch {
        return { ...RETENTION_DEFAULTS };
    }
}

/** The moment before which rows of this kind are due to go, or null when the
 *  answer is "never". Exported so the sweep and any screen that wants to say
 *  what will happen agree on the arithmetic. */
export function retentionCutoff(days: RetentionDays, now: Date = new Date()): Date | null {
    if (days === 0) return null;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
