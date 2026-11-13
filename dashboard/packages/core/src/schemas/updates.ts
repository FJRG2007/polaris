/**
 * When Polaris is allowed to install its own updates, and where an update comes
 * from.
 *
 * Four answers cover what an operator actually wants: never (tell me, I will
 * press the button), as soon as a build is published, at the hour this
 * deployment is least used, or at a fixed time of day. The quiet hour is the
 * default, so a deployment nobody looks after still stays current, and the
 * restart lands when nobody is using the box.
 *
 * The schedule is anchored to the moment an update became available, not to a
 * calendar day, so "daily at 05:00" means the first 05:00 after the build
 * appeared. A build published at 02:00 installs the same morning, one published
 * at 07:00 waits for tomorrow, and nothing is ever skipped because a window
 * closed while the deployment was off.
 *
 * Times are the server's own clock. Polaris has no per-deployment time zone, and
 * inventing one here would make the setting mean something different from the
 * host it restarts.
 */

import { z } from "zod";

/**
 * Where an update comes from.
 *
 *   image - fetch the build GitHub already made. Minutes of CI work the
 *           deployment does not repeat, and the image is the one every other
 *           deployment runs, so it is the default.
 *   build - advance the checkout and build the image on this host. Slower and it
 *           needs the machine to have the room for a build, but it installs the
 *           branch as it is right now rather than waiting on a publish, which is
 *           what a fork or a patched deployment needs.
 */
export const UPDATE_SOURCES = ["image", "build"] as const;

export type UpdateSource = (typeof UPDATE_SOURCES)[number];

export const updateSourceSchema = z.enum(UPDATE_SOURCES);

/** What a deployment does before anyone chooses: take what CI published. */
export const DEFAULT_UPDATE_SOURCE: UpdateSource = "image";

/** Read a stored source, falling back to the default rather than failing - an
 *  unreadable setting must never leave a deployment unable to update. */
export function parseUpdateSource(raw: string | null | undefined): UpdateSource {
    const parsed = updateSourceSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_UPDATE_SOURCE;
}

/** How an update gets installed once one is published. */
export const AUTO_UPDATE_MODES = ["off", "immediate", "quiet", "daily"] as const;

export type AutoUpdateMode = (typeof AUTO_UPDATE_MODES)[number];

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const autoUpdatePolicySchema = z.object({
    mode: z.enum(AUTO_UPDATE_MODES),
    /** 24-hour "HH:MM" in the server's time. Only read in `daily`, but always
     *  kept, so switching modes back does not lose the hour that was picked. */
    at: z.string().regex(TIME_OF_DAY, "Use a 24-hour time, like 05:00")
});

export type AutoUpdatePolicy = z.infer<typeof autoUpdatePolicySchema>;

/**
 * What a deployment does before anyone chooses: install at the quiet hour.
 *
 * Only an absent row reads as this. The row is written by nothing but the
 * schedule control in Settings, so a stored "off" is somebody's choice and is
 * kept; a deployment where nobody ever picked follows this default, including
 * those installed while the default was "off".
 */
export const DEFAULT_AUTO_UPDATE: AutoUpdatePolicy = { mode: "quiet", at: "05:00" };

/** Read the stored policy, falling back to the default rather than failing - an
 *  unreadable setting must never leave the watcher unable to decide. */
export function parseAutoUpdatePolicy(raw: string | null | undefined): AutoUpdatePolicy {
    if (!raw) return DEFAULT_AUTO_UPDATE;
    try {
        const parsed = autoUpdatePolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_AUTO_UPDATE;
    } catch {
        return DEFAULT_AUTO_UPDATE;
    }
}

export function stringifyAutoUpdatePolicy(policy: AutoUpdatePolicy): string {
    return JSON.stringify(policy);
}

/** The first time `at` comes round on or after `from`. */
export function nextDailyRun(at: string, from: Date): Date {
    const [hours, minutes] = at.split(":").map(Number);
    const run = new Date(from);
    run.setHours(hours ?? 0, minutes ?? 0, 0, 0);
    if (run.getTime() < from.getTime()) run.setDate(run.getDate() + 1);
    return run;
}

/** The first time the quiet hour (0-23, server time) comes round on or after
 *  `from`. */
export function nextQuietRun(quietHour: number, from: Date): Date {
    const hour = Math.min(23, Math.max(0, Math.trunc(quietHour)));
    return nextDailyRun(`${String(hour).padStart(2, "0")}:00`, from);
}

/** When an update that became available at `availableSince` installs itself, or
 *  null when this policy never installs one. `quietHour` is the hour this
 *  deployment is least used, read only in `quiet`. */
export function autoUpdateRunsAt(
    policy: AutoUpdatePolicy,
    availableSince: Date,
    quietHour: number
): Date | null {
    if (policy.mode === "off") return null;
    if (policy.mode === "immediate") return availableSince;
    if (policy.mode === "quiet") return nextQuietRun(quietHour, availableSince);
    return nextDailyRun(policy.at, availableSince);
}

/**
 * Installing an update on its own because it fixes a vulnerability, whatever the
 * general policy above says.
 *
 * Each severity has its own answer:
 *
 *   immediate - as soon as the build that fixes it is published.
 *   quiet     - at the hour this deployment is least used (`quietHour`), so the
 *               restart lands when nobody notices it.
 *   daily     - every day at a time the administrator picks (`times`), as the
 *               general policy's "every day at" does.
 *   off       - only tell the operator, as any other update.
 *
 * Critical and high install at once by default. Taking either below that is
 * allowed, but it is accepting a known risk, so it is recorded with who accepted
 * it and when (`riskAccepted`), and the settings screen asks for that in words
 * before saving. Medium and low wait for the quiet hour, so the restart
 * lands when nobody notices it; "off" is there for whoever wants to choose.
 */
export const SECURITY_UPDATE_TIMINGS = ["immediate", "quiet", "daily", "off"] as const;

export type SecurityUpdateTiming = (typeof SECURITY_UPDATE_TIMINGS)[number];

const timing = z.enum(SECURITY_UPDATE_TIMINGS);

/** The time a severity set to `daily` installs at, when none was picked. */
export const DEFAULT_SECURITY_DAILY_AT = "05:00";

/** "HH:MM" per severity, for the ones set to `daily`. A policy saved before this
 *  existed has none, and a severity without one uses the default. */
export const securityUpdateTimesSchema = z
    .object({
        critical: z.string().regex(TIME_OF_DAY),
        high: z.string().regex(TIME_OF_DAY),
        medium: z.string().regex(TIME_OF_DAY),
        low: z.string().regex(TIME_OF_DAY)
    })
    .partial()
    .strict();

export type SecurityUpdateTimes = z.infer<typeof securityUpdateTimesSchema>;

export const securityUpdatePolicySchema = z.object({
    critical: timing,
    high: timing,
    medium: timing,
    low: timing,
    times: securityUpdateTimesSchema.default({}),
    /** Who took critical or high below `immediate`, and when. Null while both
     *  install at once. */
    riskAccepted: z
        .object({ by: z.string().min(1).max(200), at: z.string().datetime() })
        .nullable()
});

export type SecurityUpdatePolicy = z.infer<typeof securityUpdatePolicySchema>;

export const DEFAULT_SECURITY_UPDATE: SecurityUpdatePolicy = {
    critical: "immediate",
    high: "immediate",
    medium: "quiet",
    low: "quiet",
    times: {},
    riskAccepted: null
};

/** Whether this policy leaves a critical or high fix waiting on somebody. */
export function securityPolicyTakesRisk(policy: Pick<SecurityUpdatePolicy, "critical" | "high">): boolean {
    return policy.critical !== "immediate" || policy.high !== "immediate";
}

/** How long a timing leaves a fix waiting, shortest first. */
const WAIT_RANK: Readonly<Record<SecurityUpdateTiming, number>> = {
    immediate: 0,
    quiet: 1,
    daily: 1,
    off: 2
};

/** Whether `next` leaves a critical or high fix waiting longer than `previous`. */
export function securityPolicyLowers(
    previous: Pick<SecurityUpdatePolicy, "critical" | "high">,
    next: Pick<SecurityUpdatePolicy, "critical" | "high">
): boolean {
    return (["critical", "high"] as const).some(
        (severity) => WAIT_RANK[next[severity]] > WAIT_RANK[previous[severity]]
    );
}

/** Read the stored policy, falling back to the default (the safe one) rather
 *  than failing - an unreadable setting must never switch these off. */
export function parseSecurityUpdatePolicy(raw: string | null | undefined): SecurityUpdatePolicy {
    if (!raw) return DEFAULT_SECURITY_UPDATE;
    try {
        const parsed = securityUpdatePolicySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return DEFAULT_SECURITY_UPDATE;
        // A risk with nobody recorded as accepting it was never accepted.
        if (securityPolicyTakesRisk(parsed.data) && !parsed.data.riskAccepted) {
            return DEFAULT_SECURITY_UPDATE;
        }
        return parsed.data;
    } catch {
        return DEFAULT_SECURITY_UPDATE;
    }
}

/**
 * When an update that fixes a vulnerability of `severity`, first seen at
 * `availableSince`, installs itself, or null when this policy leaves it to the
 * operator. `quietHour` is the hour (0-23, server time) this deployment is least
 * used.
 */
export function securityUpdateRunsAt(
    policy: SecurityUpdatePolicy,
    severity: "critical" | "high" | "medium" | "low",
    availableSince: Date,
    quietHour: number
): Date | null {
    const answer = policy[severity];
    if (answer === "off") return null;
    if (answer === "immediate") return availableSince;
    if (answer === "daily") {
        return nextDailyRun(policy.times[severity] ?? DEFAULT_SECURITY_DAILY_AT, availableSince);
    }
    return nextQuietRun(quietHour, availableSince);
}
