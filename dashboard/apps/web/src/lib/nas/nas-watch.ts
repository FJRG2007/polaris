/**
 * What the storage tick does with a NAS beyond Drive's own sample: keep its
 * chart reading, and tell Automations when one of its alert conditions starts.
 *
 * Alerts are not a new engine. Each condition that starts is sent as an
 * automation event (`core.event`, the same path `automation.finished` takes),
 * named `nas.<kind>`, on the NAS owner's shelf, so a "When an event happens"
 * trigger picks it up and its steps notify through the bell or a channel
 * webhook like any other automation. The keys seen last are stored on the
 * connection, so a condition that lasts sends one event, not one per poll, and
 * one that clears and comes back sends another.
 *
 * Disk temperature above N: today the limit is DEFAULT_ALERT_LIMITS. Once the
 * threshold trigger lands, the per-bay temperature this module stores is the
 * reading it would watch, and `nas.disk-temperature` stays for the fixed line.
 */

import { prisma } from "@polaris/db";
import type { UnasMetrics } from "@/lib/unifi-unas";
import {
    newAlerts,
    unasAlerts,
    type UnasAlert,
    type UnasBackupTask
} from "@/lib/unifi-unas-control";
import { emitAutomationEvent } from "@/lib/automations/outbox";
import { pruneNasSamples, recordNasSample } from "./nas-history";

/** The prefix every NAS event name starts with. */
export const NAS_EVENT_PREFIX = "nas.";
/** The NAS answered nothing this tick. Not one of unasAlerts': it needs no snapshot. */
export const OFFLINE_KEY = "offline";
/** Missed polls in a row before the NAS counts as offline, so one timeout is not an outage. */
export const OFFLINE_AFTER_MISSES = 2;
/** The key prefixes of unasAlerts' backup conditions. */
const BACKUP_KEY_PREFIXES = ["backup:", "overdue:"] as const;

/** Polls missed in a row, per connection. In this process only: a restart counts again. */
const misses = new Map<string, number>();

export const NAS_EVENT_NAMES = [
    "nas.offline",
    "nas.pool-unprotected",
    "nas.pool-usage",
    "nas.disk-unhealthy",
    "nas.disk-temperature",
    "nas.backup-failed",
    "nas.backup-overdue"
] as const;

export interface NasEvent {
    readonly name: string;
    readonly payload: Record<string, unknown>;
}

/** The events one poll sends, given the keys the previous one stored. Pure. */
export function nasEvents(
    nas: { readonly id: string; readonly name: string },
    previousKeys: readonly string[],
    current: readonly UnasAlert[]
): NasEvent[] {
    const previous = previousKeys.map((key) => ({ key }) as UnasAlert);
    return newAlerts(previous, current).map((alert) => ({
        name: `${NAS_EVENT_PREFIX}${alert.kind}`,
        payload: {
            nasId: nas.id,
            nasName: nas.name,
            kind: alert.kind,
            subject: alert.subject,
            value: alert.value
        }
    }));
}

/** The offline condition as an alert, so it diffs like the rest. */
export function offlineAlert(nasName: string): UnasAlert {
    return { kind: "offline", key: OFFLINE_KEY, subject: nasName, value: null };
}

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

interface WatchedNas {
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly nasAlertKeys: readonly string[];
}

async function send(
    nas: WatchedNas,
    alerts: readonly UnasAlert[],
    held: readonly string[],
    ts: Date
): Promise<void> {
    const events = nasEvents(nas, nas.nasAlertKeys, alerts);
    for (const event of events) {
        await emitAutomationEvent("core.event", {
            userId: nas.ownerId,
            subjectKey: event.name,
            payload: { name: event.name, payload: event.payload },
            // One event per condition start: a crash and retry of the same tick
            // finds the row it already wrote.
            dedupeKey: `${event.name}:${nas.id}:${String(event.payload.subject)}:${ts.getTime()}`
        });
    }
    const keys = [...new Set([...alerts.map((alert) => alert.key), ...held])].sort();
    const before = [...nas.nasAlertKeys].sort();
    if (keys.join("\n") !== before.join("\n")) {
        await prisma.storageConnection.update({
            where: { id: nas.id },
            data: { nasAlertKeys: keys }
        });
    }
}

/**
 * One NAS's tick, after Drive's own sample. `metrics` is null when the NAS did
 * not answer; `tasks` is null when its backup tasks could not be read, and is
 * the same reading the owner's notices were worked out from. Never throws: a NAS that cannot be charted or alerted on must
 * not cost the other storage its sample.
 */
export async function watchNas(
    connectionId: string,
    metrics: UnasMetrics | null,
    ts: Date,
    tasks: readonly UnasBackupTask[] | null
): Promise<void> {
    try {
        const nas = await prisma.storageConnection.findUnique({
            where: { id: connectionId },
            select: { id: true, name: true, ownerId: true, nasAlertKeys: true, kind: true }
        });
        if (!nas || nas.kind !== "unifi-unas" || !nas.ownerId) return;
        const watched: WatchedNas = { ...nas, ownerId: nas.ownerId };
        if (!metrics) {
            const missed = (misses.get(nas.id) ?? 0) + 1;
            misses.set(nas.id, missed);
            if (missed < OFFLINE_AFTER_MISSES) return;
            const held = heldKeys(nas.nasAlertKeys, "offline");
            await send(watched, [offlineAlert(nas.name)], held, ts);
            return;
        }
        misses.delete(nas.id);
        await recordNasSample(nas.id, metrics, ts);
        const held = heldKeys(nas.nasAlertKeys, tasks === null ? "no-tasks" : "full");
        await send(watched, unasAlerts(metrics, tasks ?? [], ts), held, ts);
        await pruneNasSamples(ts.getTime());
    } catch (error) {
        console.error("polaris: a NAS reading could not be kept:", error);
    }
}
