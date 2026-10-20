/**
 * The UNAS console beyond the metrics snapshot: the native fan profile, the
 * Drive backup tasks, and the alert conditions an Automation triggers on.
 *
 * Polaris reads the NAS the way Drive already does - a local console account
 * stored (encrypted) on the Drive connection, signed in over HTTPS - rather
 * than through the Home Assistant agent's MQTT topics. That needs no broker, no
 * SSH and nothing installed on the NAS, so it works the moment the Drive
 * connection exists. Endpoint sources: plugins/unifi-unas/docs/data-sources.md
 * (Drive paths are served under `/proxy/drive` through UniFi OS).
 */

import { Agent, fetch } from "undici";

import type { UnasMetrics, UnasTarget } from "@/lib/unifi-unas";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });

export const FAN_CONTROL_PATH = "/proxy/drive/api/v2/systems/fan-control";
export const BACKUP_TASKS_PATH = "/proxy/drive/api/v2/remote-backup/tasks";
export const backupRunPath = (taskId: string) =>
    `/proxy/drive/api/v2/remote-backup/run-task/${encodeURIComponent(taskId)}`;

/** A scheduled backup counts as overdue once its next run is this far behind. */
export const BACKUP_OVERDUE_GRACE_MS = 60 * 60 * 1000;

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

export type UnasAlertKind =
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
        const degraded = pool.membersExpected > 0 && pool.membersPresent < pool.membersExpected;
        const noRaid = !pool.raidLevel || pool.raidLevel === "raid0" || pool.raidLevel === "none";
        if (degraded || noRaid || pool.raidState === "degraded") {
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

interface ConsoleSession {
    readonly base: string;
    readonly cookie: string;
    readonly csrf: string | null;
}

async function signIn(target: UnasTarget): Promise<ConsoleSession> {
    const scheme = target.secure === false ? "http" : "https";
    const port = target.port && target.port !== 443 ? `:${target.port}` : "";
    const base = `${scheme}://${target.host}${port}`;
    const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            username: target.username,
            password: target.password,
            rememberMe: true
        }),
        dispatcher: insecure
    });
    if (!response.ok) throw new Error(`UNAS login failed (${response.status})`);
    const token = /TOKEN=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    if (!token) throw new Error("UNAS login returned no session cookie");
    const csrf =
        response.headers.get("x-csrf-token") ?? response.headers.get("x-updated-csrf-token");
    return { base, cookie: `TOKEN=${token}`, csrf };
}

async function call(
    session: ConsoleSession,
    method: string,
    path: string,
    body?: unknown
): Promise<unknown> {
    const headers: Record<string, string> = { cookie: session.cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && session.csrf) headers["x-csrf-token"] = session.csrf;
    const response = await fetch(`${session.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: insecure
    });
    if (!response.ok) throw new Error(`UNAS ${method} ${path} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

export async function readFanProfile(target: UnasTarget): Promise<UnasFanProfile | null> {
    return parseFanProfile(await call(await signIn(target), "GET", FAN_CONTROL_PATH));
}

export async function writeFanProfile(target: UnasTarget, profile: UnasFanProfile): Promise<void> {
    await call(await signIn(target), "PUT", FAN_CONTROL_PATH, {
        profile: FAN_PROFILE_API[profile]
    });
}

export async function listBackupTasks(target: UnasTarget): Promise<UnasBackupTask[]> {
    return parseBackupTasks(await call(await signIn(target), "GET", BACKUP_TASKS_PATH));
}

export async function runBackupTask(target: UnasTarget, taskId: string): Promise<void> {
    await call(await signIn(target), "POST", backupRunPath(taskId), {});
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
function str(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}
