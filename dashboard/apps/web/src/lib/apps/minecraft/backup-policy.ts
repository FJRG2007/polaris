/**
 * How often a world is copied, and how many copies are kept.
 *
 * The two halves belong together for one reason: a schedule without a retention
 * rule is a disk that fills up, and a full disk on a game server does not fail
 * politely - the world stops being writable and what is lost is the thing the
 * backups existed to protect. So turning the schedule on requires an answer to
 * "and then what", and the default answer is a modest one rather than none.
 *
 * Two limits rather than one, because operators reason in both. A count is what
 * somebody means by "keep a week of dailies"; a size is what they mean when the
 * machine has 20 GB free and a world of unknown growth. Either may be off, and
 * when both are on, both are enforced - the stricter one simply bites first.
 *
 * Pure: what the sweep actually does with these answers is world-service.
 */

/** How often a copy is taken. Nothing faster than hourly: a world worth backing
 *  up takes real seconds to archive, and a schedule that overlaps its own last
 *  run is a server that is always mid-backup. */
export type BackupEvery = "off" | "hourly" | "six-hourly" | "daily" | "weekly";

export interface BackupPolicy {
    readonly every: BackupEvery;
    /** How many archives to keep, oldest pruned first. 0 means no count limit. */
    readonly keepLast: number;
    /** A budget for every archive together, in bytes. 0 means no size limit. */
    readonly maxBytes: number;
    /** Whether a scheduled backup that fails is worth telling somebody about. */
    readonly notifyOnFailure: boolean;
}

/** Off, and sensible the moment it is turned on. */
export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
    every: "off",
    keepLast: 7,
    maxBytes: 0,
    notifyOnFailure: true
};

/** The most archives anyone is asked to reason about, and the largest budget
 *  worth typing. Both are guards on a form, not opinions about storage. */
export const MAX_KEEP_LAST = 200;
export const MAX_BACKUP_BYTES = 2 * 1024 ** 4;

const INTERVALS: Record<Exclude<BackupEvery, "off">, number> = {
    hourly: 60 * 60 * 1000,
    "six-hourly": 6 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000
};

export const BACKUP_EVERY_OPTIONS: readonly { readonly value: BackupEvery; readonly label: string }[] = [
    { value: "off", label: "Never - only when I ask" },
    { value: "hourly", label: "Every hour" },
    { value: "six-hourly", label: "Every six hours" },
    { value: "daily", label: "Every day" },
    { value: "weekly", label: "Every week" }
];

function isEvery(value: unknown): value is BackupEvery {
    return value === "off" || value === "hourly" || value === "six-hourly" || value === "daily" || value === "weekly";
}

/** A whole number inside a range, from whatever was in the config column. */
function bounded(value: unknown, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(0, Math.floor(value)));
}

/**
 * The policy out of an install's config.
 *
 * Every field falls back on its own rather than the object being rejected whole:
 * this is read on the path that decides whether to take a backup, and a config
 * somebody hand-edited must degrade to the default schedule, not to no backups at
 * all without saying so.
 */
export function readBackupPolicy(config: Record<string, unknown>): BackupPolicy {
    const raw = config.backupPolicy;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_BACKUP_POLICY;
    const held = raw as Record<string, unknown>;
    return {
        every: isEvery(held.every) ? held.every : DEFAULT_BACKUP_POLICY.every,
        keepLast: bounded(held.keepLast, MAX_KEEP_LAST, DEFAULT_BACKUP_POLICY.keepLast),
        maxBytes: bounded(held.maxBytes, MAX_BACKUP_BYTES, DEFAULT_BACKUP_POLICY.maxBytes),
        notifyOnFailure:
            typeof held.notifyOnFailure === "boolean"
                ? held.notifyOnFailure
                : DEFAULT_BACKUP_POLICY.notifyOnFailure
    };
}

/**
 * Whether a copy is due.
 *
 * Measured from the newest archive that exists rather than from a "last run"
 * timestamp, so the answer survives everything that could desynchronise the two:
 * a restart, a restore, an operator deleting the last backup, or a sweep that
 * recorded a run it never finished. What is on disk is the only thing that
 * matters, and it is also the only thing that cannot be wrong.
 */
export function backupDue(policy: BackupPolicy, newest: Date | null, now: Date): boolean {
    if (policy.every === "off") return false;
    if (newest === null) return true;
    return now.getTime() - newest.getTime() >= INTERVALS[policy.every];
}

/** When the next one would be taken, for a screen to say it. Null when the
 *  schedule is off. */
export function nextBackupAt(policy: BackupPolicy, newest: Date | null): Date | null {
    if (policy.every === "off") return null;
    if (newest === null) return new Date();
    return new Date(newest.getTime() + INTERVALS[policy.every]);
}

/** An archive, as retention needs to see it. */
export interface RetainableBackup {
    readonly name: string;
    readonly sizeBytes: number;
    readonly createdAt: string;
}

/**
 * Which archives to delete, oldest first.
 *
 * The newest is never proposed, whatever the limits say. A budget smaller than a
 * single world would otherwise resolve to deleting everything, which turns a
 * misconfigured number into the exact outcome backups exist to prevent - and a
 * server with one backup too large for its budget is better described by the
 * screen than fixed by deletion.
 */
export function backupsToPrune(
    backups: readonly RetainableBackup[],
    policy: BackupPolicy
): string[] {
    if (backups.length <= 1) return [];
    // Newest first, so what is kept is decided from the top down.
    const ordered = [...backups].sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const doomed = new Set<string>();

    if (policy.keepLast > 0) {
        for (const backup of ordered.slice(policy.keepLast)) doomed.add(backup.name);
    }

    if (policy.maxBytes > 0) {
        let total = 0;
        for (const backup of ordered) {
            if (doomed.has(backup.name)) continue;
            total += backup.sizeBytes;
            if (total > policy.maxBytes) doomed.add(backup.name);
        }
    }

    // Whatever the arithmetic said, one copy survives.
    doomed.delete(ordered[0]?.name ?? "");
    return ordered
        .filter((backup) => doomed.has(backup.name))
        .map((backup) => backup.name)
        .reverse();
}

/** What the archives take up together, for the screen and for the budget. */
export function totalBackupBytes(backups: readonly RetainableBackup[]): number {
    return backups.reduce((total, backup) => total + backup.sizeBytes, 0);
}
