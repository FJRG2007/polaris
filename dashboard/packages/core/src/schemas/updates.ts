/**
 * When Polaris is allowed to install its own updates, and where an update comes
 * from.
 *
 * Three answers cover what an operator actually wants: never (tell me, I will
 * press the button), as soon as a build is published, or at a fixed time of day
 * so a restart lands when nobody is using the box. The third is the reason this
 * is a policy rather than a boolean.
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
export const AUTO_UPDATE_MODES = ["off", "immediate", "daily"] as const;

export type AutoUpdateMode = (typeof AUTO_UPDATE_MODES)[number];

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const autoUpdatePolicySchema = z.object({
    mode: z.enum(AUTO_UPDATE_MODES),
    /** 24-hour "HH:MM" in the server's time. Only read in `daily`, but always
     *  kept, so switching modes back does not lose the hour that was picked. */
    at: z.string().regex(TIME_OF_DAY, "Use a 24-hour time, like 05:00")
});

export type AutoUpdatePolicy = z.infer<typeof autoUpdatePolicySchema>;

/** What a deployment does before anyone chooses: nothing but tell the operator. */
export const DEFAULT_AUTO_UPDATE: AutoUpdatePolicy = { mode: "off", at: "05:00" };

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

/** When an update that became available at `availableSince` installs itself, or
 *  null when this policy never installs one. */
export function autoUpdateRunsAt(policy: AutoUpdatePolicy, availableSince: Date): Date | null {
    if (policy.mode === "off") return null;
    if (policy.mode === "immediate") return availableSince;
    return nextDailyRun(policy.at, availableSince);
}
