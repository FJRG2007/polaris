/**
 * The UNAS console beyond the metrics snapshot: the native fan profile, the
 * Drive backup tasks, and the alert conditions an Automation triggers on.
 *
 * Polaris reads the NAS the way Drive already does - a local console account
 * stored (encrypted) on the Drive connection, signed in over HTTPS - rather
 * than through the Home Assistant agent's MQTT topics. That needs no broker, no
 * SSH and nothing installed on the NAS, so it works the moment the Drive
 * connection exists. Endpoint sources: docs/unifi-unas-data-sources.md
 * (Drive paths are served under `/proxy/drive` through UniFi OS).
 */

import { fetch } from "undici";
import { createHash } from "node:crypto";

import {
    insecure,
    signIn,
    type ConsoleSession,
    type UnasMetrics,
    type UnasTarget
} from "@/lib/unifi-unas";
import { backupFailed, backupOverdue } from "@/lib/nas/nas-view";

export { BACKUP_OVERDUE_GRACE_MS, backupFailed, backupOverdue } from "@/lib/nas/nas-view";

/** How long one console request may take before it is given up on. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Accounts whose sessions are kept; past this the oldest is dropped. */
const MAX_SESSIONS = 32;

export const FAN_CONTROL_PATH = "/proxy/drive/api/v2/systems/fan-control";
export const BACKUP_TASKS_PATH = "/proxy/drive/api/v2/remote-backup/tasks";
export const backupRunPath = (taskId: string) =>
    `/proxy/drive/api/v2/remote-backup/run-task/${encodeURIComponent(taskId)}`;

export type UnasFanProfile = "quiet" | "balanced" | "cooling";
/** Option -> value the Drive API takes (Balanced is sent as `default`). */
export const FAN_PROFILE_API: Record<UnasFanProfile, string> = {
    quiet: "quiet",
    balanced: "default",
    cooling: "cooling"
};

export function parseFanProfile(data: unknown): UnasFanProfile | null {
    const record = asRecord(data);
    for (const key of ["profile", "fanProfile", "mode"]) {
        const raw = record[key];
        if (typeof raw !== "string") continue;
        const value = raw.trim().toLowerCase();
        if (value === "quiet") return "quiet";
        if (["balanced", "balance", "default", "default_profile"].includes(value))
            return "balanced";
        if (value === "cooling" || value === "cool") return "cooling";
    }
    return "data" in record ? parseFanProfile(record.data) : null;
}

export interface UnasBackupTask {
    readonly id: string;
    readonly name: string;
    readonly scheduleEnabled: boolean;
    readonly nextRun: string | null;
    readonly lastStatus: string | null;
    readonly lastStartedAt: string | null;
    readonly lastFinishedAt: string | null;
    readonly errorCodes: string[];
    readonly remoteType: string | null;
}

export function parseBackupTasks(data: unknown): UnasBackupTask[] {
    const record = asRecord(data);
    const list = Array.isArray(data) ? data : Array.isArray(record.data) ? record.data : [];
    return list.map(asRecord).flatMap((task) => {
        const id = str(task.id);
        if (!id) return [];
        const last = asRecord(task.lastTaskRun);
        return [
            {
                id,
                name: str(task.name) ?? id,
                scheduleEnabled: asRecord(task.schedule).enable === true,
                nextRun: str(task.nextBackup),
                lastStatus: str(last.status),
                lastStartedAt: str(last.startedAt),
                lastFinishedAt: str(last.finishedAt),
                errorCodes: Array.isArray(last.errorCodes) ? last.errorCodes.map(String) : [],
                remoteType: str(asRecord(task.remote).type)
            }
        ];
    });
}

export type UnasAlertKind =
    /** Raised by the watcher when the console does not answer, not by unasAlerts. */
    | "offline"
    | "pool-unprotected"
    | "pool-usage"
    | "disk-unhealthy"
    | "disk-temperature"
    | "backup-failed"
    | "backup-overdue";

export interface UnasAlert {
    readonly kind: UnasAlertKind;
    /** Stable per subject so a trigger fires once per condition, not per poll. */
    readonly key: string;
    readonly subject: string;
    readonly value: number | null;
}

export interface UnasAlertLimits {
    readonly usagePercent: number;
    readonly diskTemperature: number;
}
export const DEFAULT_ALERT_LIMITS: UnasAlertLimits = { usagePercent: 85, diskTemperature: 50 };

/** Every alert condition the NAS is in right now. */
export function unasAlerts(
    metrics: UnasMetrics,
    tasks: readonly UnasBackupTask[],
    now: Date,
    limits: UnasAlertLimits = DEFAULT_ALERT_LIMITS
): UnasAlert[] {
    const alerts: UnasAlert[] = [];
    for (const pool of metrics.pools) {
        // Only a pool that lost a member is news. One built without redundancy
        // (a single disk, RAID 0) is how its owner set it up, and saying so on
        // every reading is noise nobody can act on.
        const degraded = pool.membersExpected > 0 && pool.membersPresent < pool.membersExpected;
        if (degraded || pool.raidState === "degraded") {
            alerts.push({
                kind: "pool-unprotected",
                key: `pool:${pool.device}`,
                subject: pool.device,
                value: null
            });
        }
        const usage =
            pool.totalBytes > 0 ? Math.round((pool.usedBytes / pool.totalBytes) * 100) : 0;
        if (usage > limits.usagePercent) {
            alerts.push({
                kind: "pool-usage",
                key: `usage:${pool.device}`,
                subject: pool.device,
                value: usage
            });
        }
    }
    for (const disk of metrics.disks) {
        if (!disk.present) continue;
        if (!disk.healthy) {
            alerts.push({
                kind: "disk-unhealthy",
                key: `disk:${disk.slot}`,
                subject: `${disk.slot}`,
                value: null
            });
        }
        if (disk.temperature !== null && disk.temperature > limits.diskTemperature) {
            alerts.push({
                kind: "disk-temperature",
                key: `temp:${disk.slot}`,
                subject: `${disk.slot}`,
                value: disk.temperature
            });
        }
    }
    for (const task of tasks) {
        if (backupFailed(task)) {
            alerts.push({
                kind: "backup-failed",
                key: `backup:${task.id}`,
                subject: task.name,
                value: null
            });
        }
        if (backupOverdue(task, now)) {
            alerts.push({
                kind: "backup-overdue",
                key: `overdue:${task.id}`,
                subject: task.name,
                value: null
            });
        }
    }
    return alerts;
}

/** Alerts present now that were not present in the previous poll. */
export function newAlerts(
    previous: readonly UnasAlert[],
    current: readonly UnasAlert[]
): UnasAlert[] {
    const before = new Set(previous.map((alert) => alert.key));
    return current.filter((alert) => !before.has(alert.key));
}

/** The NAS answered nothing. Not one of unasAlerts': it needs no snapshot. */
export const OFFLINE_KEY = "offline";
/** The key prefixes of unasAlerts' backup conditions. */
const BACKUP_KEY_PREFIXES = ["backup:", "overdue:"] as const;

/**
 * The stored keys this reading cannot speak to, kept as they were so they do
 * not clear now and start again on the next reading. Offline keeps every
 * condition the NAS was in; a reading without backup tasks keeps the backup
 * ones. Pure.
 */
export function heldKeys(
    previousKeys: readonly string[],
    reading: "offline" | "no-tasks" | "full"
): string[] {
    if (reading === "full") return [];
    if (reading === "offline") return previousKeys.filter((key) => key !== OFFLINE_KEY);
    return previousKeys.filter((key) =>
        BACKUP_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
}

/**
 * One console session per account, reused until the console stops taking it,
 * so a poll does not open a new `rememberMe` session on the NAS every time.
 */
const sessions = new Map<string, Promise<ConsoleSession>>();

function sessionKey(target: UnasTarget): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                target.host,
                target.port ?? null,
                target.secure ?? null,
                target.username,
                target.password
            ])
        )
        .digest("hex");
}

function session(key: string, target: UnasTarget): Promise<ConsoleSession> {
    const kept = sessions.get(key);
    if (kept) return kept;
    const pending = signIn(target);
    sessions.set(key, pending);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    pending.catch(() => {
        if (sessions.get(key) === pending) sessions.delete(key);
    });
    return pending;
}

async function call(
    target: UnasTarget,
    method: string,
    path: string,
    body?: unknown
): Promise<unknown> {
    const key = sessionKey(target);
    for (let attempt = 0; ; attempt++) {
        const pending = session(key, target);
        const current = await pending;
        const headers: Record<string, string> = { cookie: current.cookie };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (method !== "GET" && current.csrf) headers["x-csrf-token"] = current.csrf;
        const response = await fetch(`${current.base}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            dispatcher: insecure,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (response.status === 401 || response.status === 403) {
            if (sessions.get(key) === pending) sessions.delete(key);
            if (attempt === 0) continue;
        }
        const rotated = response.headers.get("x-updated-csrf-token");
        if (rotated && rotated !== current.csrf && sessions.get(key) === pending)
            sessions.set(key, Promise.resolve({ ...current, csrf: rotated }));
        if (!response.ok) throw new Error(`UNAS ${method} ${path} failed (${response.status})`);
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }
}

export async function readFanProfile(target: UnasTarget): Promise<UnasFanProfile | null> {
    return parseFanProfile(await call(target, "GET", FAN_CONTROL_PATH));
}

export async function writeFanProfile(target: UnasTarget, profile: UnasFanProfile): Promise<void> {
    await call(target, "PUT", FAN_CONTROL_PATH, {
        profile: FAN_PROFILE_API[profile]
    });
}

export async function listBackupTasks(target: UnasTarget): Promise<UnasBackupTask[]> {
    return parseBackupTasks(await call(target, "GET", BACKUP_TASKS_PATH));
}

export async function runBackupTask(target: UnasTarget, taskId: string): Promise<void> {
    await call(target, "POST", backupRunPath(taskId), {});
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
function str(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}
