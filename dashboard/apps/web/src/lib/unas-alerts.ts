/**
 * Telling the owner of a UniFi UNAS connection that the NAS needs attention.
 *
 * The metrics collector reads every UNAS on its storage cadence; this takes that
 * reading plus the console's backup tasks, works out the alert conditions the
 * NAS is in (`unasAlerts`), and raises a notice only for the ones that were not
 * there on the previous reading (`newAlerts`), so a pool that stays full is one
 * notice rather than one per poll. A condition that clears and comes back is
 * news again.
 *
 * The previous set is kept in this process only: after a restart, a condition
 * still standing is said once more.
 */

import { prisma } from "@polaris/db";
import type { UnasMetrics } from "@/lib/unifi-unas";
import { notify } from "@/lib/notifications/dispatch";
import { getUnasTarget } from "@/lib/storage-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import {
    listBackupTasks,
    newAlerts,
    unasAlerts,
    type UnasAlert,
    type UnasAlertKind,
    type UnasBackupTask
} from "@/lib/unifi-unas-control";

/** Where the owner sees the NAS the notice is about. */
const OVERVIEW_HREF = "/drive/overview";

const previous = new Map<string, readonly UnasAlert[]>();

/** The kinds unasAlerts raises; offline is the NAS page watcher's alone. */
type NoticeKind = Exclude<UnasAlertKind, "offline">;

const TITLE = {
    "pool-unprotected": "unas.poolUnprotectedTitle",
    "pool-usage": "unas.poolUsageTitle",
    "disk-unhealthy": "unas.diskUnhealthyTitle",
    "disk-temperature": "unas.diskTemperatureTitle",
    "backup-failed": "unas.backupFailedTitle",
    "backup-overdue": "unas.backupOverdueTitle"
} as const satisfies Record<NoticeKind, string>;

const BODY = {
    "pool-unprotected": "unas.poolUnprotectedBody",
    "pool-usage": "unas.poolUsageBody",
    "disk-unhealthy": "unas.diskUnhealthyBody",
    "disk-temperature": "unas.diskTemperatureBody",
    "backup-failed": "unas.backupFailedBody",
    "backup-overdue": "unas.backupOverdueBody"
} as const satisfies Record<NoticeKind, string>;

/**
 * The alerts the NAS is in now. When the backup tasks could not be read this
 * time, the backup alerts of the previous reading stand, so a console that
 * skipped one answer does not clear them and raise them again on the next.
 */
export function currentAlerts(
    metrics: UnasMetrics,
    tasks: readonly UnasBackupTask[] | null,
    before: readonly UnasAlert[],
    now: Date
): UnasAlert[] {
    const alerts = unasAlerts(metrics, tasks ?? [], now);
    if (tasks !== null) return alerts;
    return [...alerts, ...before.filter((alert) => alert.kind.startsWith("backup-"))];
}

/** The console's backup tasks, or null when it did not answer them this time. */
export function readBackupTasks(connection: {
    id: string;
    ownerId: string;
}): Promise<UnasBackupTask[] | null> {
    return getUnasTarget(connection.id, connection.ownerId)
        .then(listBackupTasks)
        .catch(() => null);
}

/**
 * Raise a notice for each alert this reading started. Never throws: it runs
 * inside the metrics collector, and one NAS must not stop the others.
 */
export async function watchUnasAlerts(
    connection: { id: string; ownerId: string },
    metrics: UnasMetrics,
    tasks: readonly UnasBackupTask[] | null
): Promise<void> {
    try {
        const before = previous.get(connection.id) ?? [];
        const now = currentAlerts(metrics, tasks, before, new Date());
        previous.set(connection.id, now);
        const fresh = newAlerts(before, now);
        if (fresh.length === 0) return;

        const row = await prisma.storageConnection.findUnique({
            where: { id: connection.id },
            select: { name: true }
        });
        const name = row?.name ?? metrics.system.name;
        const t = await wordsFor(connection.ownerId, "notices");
        await Promise.allSettled(
            fresh.map((alert) => {
                if (alert.kind === "offline") return Promise.resolve();
                const kind: NoticeKind = alert.kind;
                const words = { name, subject: alert.subject, value: alert.value ?? 0 };
                return notify({
                    userId: connection.ownerId,
                    event: "storage.nasAlert",
                    title: t(TITLE[kind], words),
                    body: t(BODY[kind], words),
                    href: OVERVIEW_HREF,
                    level: "warning",
                    metadata: { connectionId: connection.id, alert: alert.key }
                });
            })
        );
    } catch (error) {
        console.error("unas: could not check the NAS alert conditions:", error);
    }
}
