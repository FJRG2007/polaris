/**
 * How often a copy is taken, and which copies are kept.
 *
 * Generalized from the Minecraft world policy this replaces, and its reasoning
 * still holds: a schedule without a retention rule is a disk that fills up, and
 * a full disk does not fail politely - what is lost is the thing the backups
 * existed to protect. So a plan answers "and then what" by construction, and the
 * default answer is a modest one rather than none.
 *
 * Three limits rather than one, because operators reason in all three. A count
 * is what somebody means by "keep a week of dailies"; an age is what they mean
 * by "thirty days"; a size is what they mean when the disk has 20 GB free. Any
 * may be off, and when several are on the strictest simply bites first.
 *
 * Retention is applied PER DESTINATION. The destinations are not equivalent - a
 * game server's own disk holds a few days and a bucket holds a year - and one
 * number for both would either fill the disk or throw away the archive somebody
 * is paying to keep.
 *
 * Pure. Nothing here reads a database or deletes anything.
 */

/** How often a copy is taken. Nothing faster than hourly: archiving a real world
 *  or database takes real seconds, and a schedule that overlaps its own last run
 *  is a thing that is permanently mid-backup. */
export const BACKUP_INTERVALS = ["off", "hourly", "six-hourly", "daily", "weekly", "monthly"] as const;

export type BackupEvery = (typeof BACKUP_INTERVALS)[number];

export interface RetentionPolicy {
    readonly every: BackupEvery;
    /** How many copies to keep per destination, newest first. 0 means no limit. */
    readonly keepLast: number;
    /** How long a copy may live, in days. 0 means no limit. */
    readonly keepDays: number;
    /** A budget for every copy in one destination together, in bytes. 0 means none. */
    readonly maxBytes: number;
    readonly notifyOnFailure: boolean;
}

/** Off, and sensible the moment it is turned on. */
export const DEFAULT_POLICY: RetentionPolicy = {
    every: "off",
    keepLast: 7,
    keepDays: 0,
    maxBytes: 0,
    notifyOnFailure: true
};

/** Guards on a form, not opinions about storage. */
export const MAX_KEEP_LAST = 500;
export const MAX_KEEP_DAYS = 3650;
export const MAX_BACKUP_BYTES = 2 * 1024 ** 4;

const MS: Record<Exclude<BackupEvery, "off">, number> = {
    hourly: 60 * 60 * 1000,
    "six-hourly": 6 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    // Not a calendar month: a fixed 30 days, so "monthly" means the same number
    // of days in February as in July and the next run is arithmetic rather than
    // a date that can land on the 31st of a month that has 30.
    monthly: 30 * 24 * 60 * 60 * 1000
};

export const BACKUP_EVERY_OPTIONS: readonly { readonly value: BackupEvery; readonly label: string }[] = [
    { value: "off", label: "Never - only when I ask" },
    { value: "hourly", label: "Every hour" },
    { value: "six-hourly", label: "Every six hours" },
    { value: "daily", label: "Every day" },
    { value: "weekly", label: "Every week" },
    { value: "monthly", label: "Every 30 days" }
];

export function isBackupEvery(value: unknown): value is BackupEvery {
    return typeof value === "string" && (BACKUP_INTERVALS as readonly string[]).includes(value);
}

/** A whole number inside a range, from whatever was stored. */
function bounded(value: unknown, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(0, Math.floor(value)));
}

/**
 * A policy out of a stored plan row.
 *
 * Every field falls back on its own rather than the object being rejected whole:
 * this is read on the path that decides whether to take a backup, and a row
 * somebody hand-edited must degrade to the default schedule, not to no backups
 * at all without saying so.
 */
export function readPolicy(row: {
    every?: unknown;
    keepLast?: unknown;
    keepDays?: unknown;
    maxBytes?: unknown;
    notifyOnFailure?: unknown;
}): RetentionPolicy {
    return {
        every: isBackupEvery(row.every) ? row.every : DEFAULT_POLICY.every,
        keepLast: bounded(row.keepLast, MAX_KEEP_LAST, DEFAULT_POLICY.keepLast),
        keepDays: bounded(row.keepDays, MAX_KEEP_DAYS, DEFAULT_POLICY.keepDays),
        maxBytes: bounded(toNumber(row.maxBytes), MAX_BACKUP_BYTES, DEFAULT_POLICY.maxBytes),
        notifyOnFailure:
            typeof row.notifyOnFailure === "boolean" ? row.notifyOnFailure : DEFAULT_POLICY.notifyOnFailure
    };
}

/** maxBytes is a BigInt column; a budget above 2^53 is not a real budget. */
function toNumber(value: unknown): unknown {
    return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Whether a copy is due.
 *
 * Measured from the newest copy that exists rather than from a "last run"
 * timestamp, so the answer survives everything that could desynchronize the two:
 * a restart, a restore, somebody deleting the last backup, or a sweep that
 * recorded a run it never finished. What exists is the only thing that matters,
 * and it is also the only thing that cannot be wrong.
 */
export function backupDue(policy: RetentionPolicy, newest: Date | null, now: Date): boolean {
    if (policy.every === "off") return false;
    if (newest === null) return true;
    return now.getTime() - newest.getTime() >= MS[policy.every];
}

/** When the next one would be taken, for a screen to say it and for the sweep to
 *  find due work with an index. Null when the schedule is off. */
export function nextBackupAt(policy: RetentionPolicy, newest: Date | null, now: Date = new Date()): Date | null {
    if (policy.every === "off") return null;
    if (newest === null) return now;
    return new Date(newest.getTime() + MS[policy.every]);
}

/** When a copy taken now would fall out of retention, or null when age is not a
 *  limit here. */
export function expiresAt(policy: RetentionPolicy, takenAt: Date): Date | null {
    if (policy.keepDays <= 0) return null;
    return new Date(takenAt.getTime() + policy.keepDays * 24 * 60 * 60 * 1000);
}

/** A copy, as retention needs to see it. */
export interface RetainableCopy {
    readonly id: string;
    readonly sizeBytes: number;
    readonly takenAt: Date;
}

/**
 * Which copies to delete in one destination, oldest first.
 *
 * The newest is never proposed, whatever the limits say. A budget smaller than a
 * single archive would otherwise resolve to deleting everything, which turns a
 * mistyped number into the exact outcome backups exist to prevent - and a
 * destination holding one copy too large for its budget is better described on
 * the screen than fixed by deletion.
 */
export function copiesToPrune(
    copies: readonly RetainableCopy[],
    policy: RetentionPolicy,
    now: Date = new Date()
): string[] {
    if (copies.length <= 1) return [];
    // Newest first, so what is kept is decided from the top down.
    const ordered = [...copies].sort((left, right) => right.takenAt.getTime() - left.takenAt.getTime());
    const doomed = new Set<string>();

    if (policy.keepLast > 0) {
        for (const copy of ordered.slice(policy.keepLast)) doomed.add(copy.id);
    }

    if (policy.keepDays > 0) {
        const cutoff = now.getTime() - policy.keepDays * 24 * 60 * 60 * 1000;
        for (const copy of ordered) {
            if (copy.takenAt.getTime() < cutoff) doomed.add(copy.id);
        }
    }

    if (policy.maxBytes > 0) {
        let total = 0;
        for (const copy of ordered) {
            if (doomed.has(copy.id)) continue;
            total += copy.sizeBytes;
            if (total > policy.maxBytes) doomed.add(copy.id);
        }
    }

    // Whatever the arithmetic said, one copy survives.
    doomed.delete(ordered[0]?.id ?? "");
    return ordered
        .filter((copy) => doomed.has(copy.id))
        .map((copy) => copy.id)
        .reverse();
}

/** What the copies take up together, for the screen and for the budget. */
export function totalBytes(copies: readonly { readonly sizeBytes: number }[]): number {
    return copies.reduce((sum, copy) => sum + copy.sizeBytes, 0);
}
