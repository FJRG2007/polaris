/**
 * Telling the owner of a UniFi UNAS connection that the NAS needs attention.
 *
 * The metrics collector reads every UNAS on its storage cadence; this takes that
 * reading plus the console's backup tasks, works out the alert conditions the
 * NAS is in (`unasAlerts`), and raises a notice only for the ones that were not
 * there on the previous reading (`noticePlan`), so a pool that stays full is one
 * notice rather than one per poll. A condition that clears and comes back is
 * news again.
 *
 * The previous set is the one the NAS watcher stores on the connection
 * (`nasAlertKeys`), so a restart - every Update is one - does not say a standing
 * condition again. The bell keeps one notice per condition, and only while it
 * stands: an older copy of the same notice, or one whose condition cleared, is
 * deleted.
 */

import { prisma } from "@polaris/db";
import type { UnasMetrics } from "@/lib/unifi-unas";
import { notify } from "@/lib/notifications/dispatch";
import { getUnasTarget } from "@/lib/storage-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import {
    heldKeys,
    listBackupTasks,
    unasAlerts,
    type UnasAlert,
    type UnasAlertKind,
    type UnasBackupTask
} from "@/lib/unifi-unas-control";

/** The bell category every NAS notice is written under. */
const NOTICE_TYPE = "storage.nasAlert";

/** Where the owner sees the NAS the notice is about. */
const OVERVIEW_HREF = "/drive/overview";

/** The bell's notices about one NAS, newest first, read to sweep them. */
const SWEEP_MOST = 200;

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
 * What one reading changes on the bell, given the keys the previous reading
 * stored. `fresh` are the conditions that just started; `standing` every key
 * still true, with the stored backup keys held when the backup tasks could not
 * be read, so a console that skipped one answer neither clears them nor raises
 * them again. Pure.
 */
export function noticePlan(
    storedKeys: readonly string[],
    alerts: readonly UnasAlert[],
    tasksRead: boolean
): { fresh: UnasAlert[]; standing: Set<string> } {
    const stored = new Set(storedKeys);
    const standing = new Set([
        ...alerts.map((alert) => alert.key),
        ...heldKeys(storedKeys, tasksRead ? "full" : "no-tasks")
    ]);
    return { fresh: alerts.filter((alert) => !stored.has(alert.key)), standing };
}

/**
 * The notices to delete: every one whose condition no longer stands, and every
 * older copy of one that does. `notices` come newest first. Pure.
 */
export function staleNotices(
    notices: readonly { id: string; metadata: string | null }[],
    standing: ReadonlySet<string>
): string[] {
    const kept = new Set<string>();
    const stale: string[] = [];
    for (const notice of notices) {
        const key = alertKeyOf(notice.metadata);
        if (key !== null && standing.has(key) && !kept.has(key)) kept.add(key);
        else stale.push(notice.id);
    }
    return stale;
}

function alertKeyOf(metadata: string | null): string | null {
    if (!metadata) return null;
    try {
        const parsed: unknown = JSON.parse(metadata);
        const alert = (parsed as { alert?: unknown } | null)?.alert;
        return typeof alert === "string" ? alert : null;
    } catch {
        return null;
    }
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
        const row = await prisma.storageConnection.findUnique({
            where: { id: connection.id },
            select: { name: true, nasAlertKeys: true }
        });
        const { fresh, standing } = noticePlan(
            row?.nasAlertKeys ?? [],
            unasAlerts(metrics, tasks ?? [], new Date()),
            tasks !== null
        );
        if (fresh.length > 0) await raise(connection, row?.name ?? metrics.system.name, fresh);
        await sweep(connection, standing);
    } catch (error) {
        console.error("unas: could not check the NAS alert conditions:", error);
    }
}

async function raise(
    connection: { id: string; ownerId: string },
    name: string,
    fresh: readonly UnasAlert[]
): Promise<void> {
    const t = await wordsFor(connection.ownerId, "notices");
    await Promise.allSettled(
        fresh.map((alert) => {
            if (alert.kind === "offline") return Promise.resolve();
            const kind: NoticeKind = alert.kind;
            const words = { name, subject: alert.subject, value: alert.value ?? 0 };
            return notify({
                userId: connection.ownerId,
                event: NOTICE_TYPE,
                title: t(TITLE[kind], words),
                body: t(BODY[kind], words),
                href: OVERVIEW_HREF,
                level: "warning",
                metadata: { connectionId: connection.id, alert: alert.key }
            });
        })
    );
}

/** Delete this NAS's notices that no longer stand, and older copies of those that do. */
async function sweep(
    connection: { id: string; ownerId: string },
    standing: ReadonlySet<string>
): Promise<void> {
    const notices = await prisma.notification.findMany({
        where: {
            userId: connection.ownerId,
            type: NOTICE_TYPE,
            // Written as JSON.stringify({ connectionId, alert }), so the prefix
            // names this NAS and no other.
            metadata: { startsWith: `{"connectionId":${JSON.stringify(connection.id)},` }
        },
        orderBy: { createdAt: "desc" },
        take: SWEEP_MOST,
        select: { id: true, metadata: true }
    });
    const stale = staleNotices(notices, standing);
    if (stale.length > 0) await prisma.notification.deleteMany({ where: { id: { in: stale } } });
}
