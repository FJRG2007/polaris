/**
 * Taking old records away, so a deployment does not become its own log.
 *
 * Three tables grow forever and nothing ever reads the old rows: the bell's
 * notifications, the activity every screen writes, and the audit trail. On an
 * instance that has been up a year they are between them the largest thing in
 * the database, and made almost entirely of lines nobody will open. There was no
 * way to bound any of them, and no way to be told there was a problem until a
 * disk filled.
 *
 * What the periods are and what they default to is `@polaris/core`, so the screen
 * offers exactly what this enforces. What lives here is the reading, the writing
 * and the sweep.
 *
 * **The sweep is bounded and re-runnable.** It takes a fixed number of rows per
 * table per pass rather than everything due, because the first pass on an
 * instance that has been running for a year is a delete of millions of rows and
 * one statement holding that lock is an outage. Falling behind is fine: the next
 * pass takes the next batch, and the schedule is minutes.
 *
 * **Nothing here reads a row before deleting it.** These are three tables of
 * append-only lines with a timestamp and an index on it; there is no file on a
 * disk behind any of them to remove first, which is what makes this different
 * from the camera sweep it sits beside.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

/** Where the policy is kept. One key holding all three, because they are read
 *  together on every pass and by one screen. */
const RETENTION_KEY = "retention.policy";

/**
 * How many rows one pass takes from each table.
 *
 * Large enough that an instance with a normal amount of history is clear in one
 * pass, small enough that the statement is over in well under a second. The
 * first pass on a deployment that has never had this catches up over several,
 * which is exactly what should happen: nobody is waiting on it.
 */
const BATCH = 5000;

/** What this deployment keeps, and for how long. */
export async function retentionPolicy(): Promise<core.RetentionPolicy> {
    return core.storedRetention(await getSetting(RETENTION_KEY));
}

/** Write it. Validated here as well as in the form, because a form is a
 *  courtesy - and because this one decides what gets deleted. */
export async function setRetentionPolicy(input: unknown): Promise<core.RetentionPolicy> {
    const policy = core.retentionPolicySchema.parse(input);
    await setSetting(RETENTION_KEY, JSON.stringify(policy));
    return policy;
}

/** What one pass took away. */
export interface RetentionSweepResult {
    readonly notifications: number;
    readonly activity: number;
    readonly audit: number;
    /** Whether anything was left for the next pass, which is what makes a first
     *  run on a year of history finish over minutes rather than in one lock. */
    readonly more: boolean;
}

/**
 * Delete the ids handed over, in one statement.
 *
 * Ids rather than a `deleteMany` on the timestamp, because `deleteMany` has no
 * limit: the bound has to be applied by the select, and then the delete has to
 * name what the select found. Two round trips per table per pass, which is
 * nothing against what it is protecting.
 */
async function removeAll(
    ids: readonly string[],
    remove: (ids: string[]) => Promise<{ count: number }>
): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await remove([...ids]);
    return count;
}

/**
 * One pass over the three tables.
 *
 * Each is independent: a failure on one leaves the reason in the log and does not
 * stop the other two, because a notification table that will not shrink is not a
 * reason to stop bounding the audit log.
 */
export async function sweepRetention(now: Date = new Date()): Promise<RetentionSweepResult> {
    const policy = await retentionPolicy();

    const notificationsCutoff = core.retentionCutoff(policy.notifications, now);
    const activityCutoff = core.retentionCutoff(policy.activity, now);
    const auditCutoff = core.retentionCutoff(policy.audit, now);

    let notifications = 0;
    let activity = 0;
    let audit = 0;
    let more = false;

    if (notificationsCutoff) {
        const due = await prisma.notification.findMany({
            where: { createdAt: { lt: notificationsCutoff } },
            orderBy: { createdAt: "asc" },
            take: BATCH,
            select: { id: true }
        });
        notifications = await removeAll(
            due.map((row) => row.id),
            (ids) => prisma.notification.deleteMany({ where: { id: { in: ids } } })
        );
        if (due.length === BATCH) more = true;
    }

    if (activityCutoff) {
        const due = await prisma.activity.findMany({
            where: { createdAt: { lt: activityCutoff } },
            orderBy: { createdAt: "asc" },
            take: BATCH,
            select: { id: true }
        });
        activity = await removeAll(
            due.map((row) => row.id),
            (ids) => prisma.activity.deleteMany({ where: { id: { in: ids } } })
        );
        if (due.length === BATCH) more = true;
    }

    if (auditCutoff) {
        // `at` rather than `createdAt`: the audit table names its timestamp
        // differently from the other two, and a sweep that guessed would delete
        // nothing forever while reporting success.
        const due = await prisma.auditLog.findMany({
            where: { at: { lt: auditCutoff } },
            orderBy: { at: "asc" },
            take: BATCH,
            select: { id: true }
        });
        audit = await removeAll(
            due.map((row) => row.id),
            (ids) => prisma.auditLog.deleteMany({ where: { id: { in: ids } } })
        );
        if (due.length === BATCH) more = true;
    }

    return { notifications, activity, audit, more };
}

/**
 * How much of each there is, and how much of it is already past its period.
 *
 * For the screen that sets the policy, because "30 days" means nothing without
 * knowing what is being kept - and because somebody about to shorten a period
 * should be able to see, before they save, how many lines that is going to take
 * away. Counted rather than listed: this is a number on a card, not a table.
 */
export async function retentionTotals(
    policy: core.RetentionPolicy,
    now: Date = new Date()
): Promise<Record<core.RetentionSubject, { total: number; due: number }>> {
    const notificationsCutoff = core.retentionCutoff(policy.notifications, now);
    const activityCutoff = core.retentionCutoff(policy.activity, now);
    const auditCutoff = core.retentionCutoff(policy.audit, now);

    const [
        notificationsTotal,
        notificationsDue,
        activityTotal,
        activityDue,
        auditTotal,
        auditDue
    ] = await Promise.all([
        prisma.notification.count(),
        notificationsCutoff
            ? prisma.notification.count({ where: { createdAt: { lt: notificationsCutoff } } })
            : Promise.resolve(0),
        prisma.activity.count(),
        activityCutoff
            ? prisma.activity.count({ where: { createdAt: { lt: activityCutoff } } })
            : Promise.resolve(0),
        prisma.auditLog.count(),
        auditCutoff
            ? prisma.auditLog.count({ where: { at: { lt: auditCutoff } } })
            : Promise.resolve(0)
    ]);

    return {
        notifications: { total: notificationsTotal, due: notificationsDue },
        activity: { total: activityTotal, due: activityDue },
        audit: { total: auditTotal, due: auditDue }
    };
}
