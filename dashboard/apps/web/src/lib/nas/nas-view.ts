/**
 * The parts of a NAS page that are plain data and arithmetic, so the screen in
 * the browser and the services on the server read them from one place. Nothing
 * here may import a server module.
 */

import type { UnasBackupTask } from "@/lib/unifi-unas-control";

export const NAS_RANGES = ["1h", "1d", "1w", "1m"] as const;
export type NasRange = (typeof NAS_RANGES)[number];

const HOUR_MS = 60 * 60 * 1000;
export const NAS_RANGE_MS: Record<NasRange, number> = {
    "1h": HOUR_MS,
    "1d": 24 * HOUR_MS,
    "1w": 7 * 24 * HOUR_MS,
    "1m": 30 * 24 * HOUR_MS
};

export interface NasDisk {
    readonly slot: number;
    readonly present: boolean;
    readonly state: string;
    readonly model: string | null;
    /** Null for a visitor: a serial is the owner's inventory, not theirs. */
    readonly serial: string | null;
    readonly sizeBytes: number;
    readonly temperature: number | null;
    readonly healthy: boolean;
    readonly powerOnHours: number | null;
    /** Which pool the drive belongs to, when the snapshot says. */
    readonly pool: string | null;
}

/** The "All Disks" row: across present drives only. Pure. */
export function allDisks(disks: readonly NasDisk[]): {
    count: number;
    maxTemp: number | null;
    minTemp: number | null;
    avgPowerOnHours: number | null;
    notOptimal: number;
} {
    const present = disks.filter((disk) => disk.present);
    const temps = present.flatMap((disk) => (disk.temperature === null ? [] : [disk.temperature]));
    const hours = present.flatMap((disk) => (disk.powerOnHours === null ? [] : [disk.powerOnHours]));
    return {
        count: present.length,
        maxTemp: temps.length > 0 ? Math.max(...temps) : null,
        minTemp: temps.length > 0 ? Math.min(...temps) : null,
        avgPowerOnHours:
            hours.length > 0 ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
        notOptimal: present.filter((disk) => !disk.healthy).length
    };
}

/** A scheduled backup counts as overdue once its next run is this far behind. */
export const BACKUP_OVERDUE_GRACE_MS = 60 * 60 * 1000;

export function backupFailed(task: UnasBackupTask): boolean {
    return task.errorCodes.length > 0;
}

export function backupOverdue(
    task: UnasBackupTask,
    now: Date,
    graceMs = BACKUP_OVERDUE_GRACE_MS
): boolean {
    if (!task.scheduleEnabled || task.lastStatus === "pending" || task.lastStatus === "in-progress")
        return false;
    const next = task.nextRun ? Date.parse(task.nextRun) : Number.NaN;
    return Number.isFinite(next) && now.getTime() - next > graceMs;
}

export type BayStatusFilter = "any" | "optimal" | "notOptimal" | "empty";
export type BayTempFilter = "any" | "cool" | "warm" | "hot";

/** Which temperature band a drive falls in. Pure. */
export function tempBand(temperature: number | null): Exclude<BayTempFilter, "any"> | null {
    if (temperature === null) return null;
    if (temperature < 40) return "cool";
    return temperature <= 50 ? "warm" : "hot";
}

/** The bays a filter set keeps. Pure. */
export function filterBays(
    disks: readonly NasDisk[],
    status: BayStatusFilter,
    temp: BayTempFilter,
    pool: string
): NasDisk[] {
    return disks.filter((disk) => {
        if (status === "empty" && disk.present) return false;
        if (status === "optimal" && !(disk.present && disk.healthy)) return false;
        if (status === "notOptimal" && !(disk.present && !disk.healthy)) return false;
        if (temp !== "any" && tempBand(disk.temperature) !== temp) return false;
        if (pool !== "" && disk.pool !== pool) return false;
        return true;
    });
}
