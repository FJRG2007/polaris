/**
 * When a copy is taken, and which copies are deleted to make room.
 *
 * The second half is the dangerous one: everything here decides what gets
 * destroyed, on a schedule, without anybody watching. A budget typed one digit
 * short must not resolve to "delete them all" - that turns a slip into exactly
 * the outcome backups exist to prevent - so the rule that one copy always
 * survives is asserted before anything else.
 */

import { describe, expect, it } from "vitest";
import * as policy from "@/lib/apps/minecraft/backup-policy";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-09T12:00:00.000Z");

function archive(hoursAgo: number, sizeBytes = 100): policy.RetainableBackup {
    const at = new Date(NOW.getTime() - hoursAgo * HOUR);
    return { name: `${at.toISOString()}.tar.gz`, sizeBytes, createdAt: at.toISOString() };
}

describe("reading a stored policy", () => {
    it("falls back field by field rather than dropping the lot", () => {
        // Read on the path that decides whether to back up at all, so a config
        // somebody hand-edited has to degrade to the default schedule and not
        // silently to no backups.
        const read = policy.readBackupPolicy({ backupPolicy: { every: "nonsense", keepLast: -4 } });

        expect(read.every).toBe(policy.DEFAULT_BACKUP_POLICY.every);
        expect(read.keepLast).toBe(0);
        expect(read.notifyOnFailure).toBe(true);
    });

    it("takes a whole policy back unchanged", () => {
        const stored = { every: "daily", keepLast: 3, maxBytes: 1024, notifyOnFailure: false };
        expect(policy.readBackupPolicy({ backupPolicy: stored })).toEqual(stored);
    });

    it("is the default for a server nobody has configured", () => {
        expect(policy.readBackupPolicy({})).toEqual(policy.DEFAULT_BACKUP_POLICY);
    });
});

describe("whether a copy is due", () => {
    const daily = { ...policy.DEFAULT_BACKUP_POLICY, every: "daily" as const };

    it("is never due while the schedule is off", () => {
        expect(policy.backupDue(policy.DEFAULT_BACKUP_POLICY, null, NOW)).toBe(false);
    });

    it("is due at once for a server with no copy at all", () => {
        expect(policy.backupDue(daily, null, NOW)).toBe(true);
    });

    it("waits the interval out, measured from the newest archive on disk", () => {
        // From what is on disk rather than a recorded run: a restart, a restore or
        // somebody deleting the last backup all desynchronise a stored timestamp,
        // and what is on disk cannot be wrong.
        expect(policy.backupDue(daily, new Date(NOW.getTime() - 23 * HOUR), NOW)).toBe(false);
        expect(policy.backupDue(daily, new Date(NOW.getTime() - 25 * HOUR), NOW)).toBe(true);
    });
});

describe("which copies are pruned", () => {
    it("keeps the newest whatever the limits say", () => {
        const backups = [archive(0, 5000), archive(24, 5000)];
        // A budget smaller than one world would otherwise resolve to deleting
        // everything.
        const doomed = policy.backupsToPrune(backups, {
            ...policy.DEFAULT_BACKUP_POLICY,
            keepLast: 0,
            maxBytes: 10
        });

        expect(doomed).not.toContain(backups[0]?.name);
        expect(doomed).toEqual([backups[1]?.name]);
    });

    it("never proposes anything when there is only one copy", () => {
        expect(policy.backupsToPrune([archive(0, 10 ** 9)], { ...policy.DEFAULT_BACKUP_POLICY, maxBytes: 1 })).toEqual(
            []
        );
        expect(policy.backupsToPrune([], policy.DEFAULT_BACKUP_POLICY)).toEqual([]);
    });

    it("keeps the last N and drops the rest, oldest first", () => {
        const backups = [archive(0), archive(24), archive(48), archive(72)];
        const doomed = policy.backupsToPrune(backups, { ...policy.DEFAULT_BACKUP_POLICY, keepLast: 2 });

        expect(doomed).toEqual([backups[3]?.name, backups[2]?.name]);
    });

    it("drops the oldest until the total is inside the budget", () => {
        const backups = [archive(0, 400), archive(24, 400), archive(48, 400)];
        const doomed = policy.backupsToPrune(backups, {
            ...policy.DEFAULT_BACKUP_POLICY,
            keepLast: 0,
            maxBytes: 900
        });

        expect(doomed).toEqual([backups[2]?.name]);
    });

    it("enforces both limits when both are set, and the stricter one bites", () => {
        const backups = [archive(0, 400), archive(24, 400), archive(48, 400), archive(72, 400)];
        const doomed = policy.backupsToPrune(backups, {
            ...policy.DEFAULT_BACKUP_POLICY,
            keepLast: 3,
            maxBytes: 900
        });

        expect(doomed).toHaveLength(2);
        expect(doomed).toContain(backups[3]?.name);
        expect(doomed).toContain(backups[2]?.name);
    });

    it("proposes nothing when neither limit is set", () => {
        const backups = [archive(0, 10 ** 9), archive(24, 10 ** 9)];
        expect(
            policy.backupsToPrune(backups, { ...policy.DEFAULT_BACKUP_POLICY, keepLast: 0, maxBytes: 0 })
        ).toEqual([]);
    });
});

describe("what the screen says", () => {
    it("has no next time while the schedule is off", () => {
        expect(policy.nextBackupAt(policy.DEFAULT_BACKUP_POLICY, null)).toBeNull();
    });

    it("counts the next one from the newest archive", () => {
        const newest = new Date(NOW.getTime() - HOUR);
        const next = policy.nextBackupAt({ ...policy.DEFAULT_BACKUP_POLICY, every: "six-hourly" }, newest);

        expect(next?.toISOString()).toBe(new Date(newest.getTime() + 6 * HOUR).toISOString());
    });

    it("adds up what the archives take", () => {
        expect(policy.totalBackupBytes([archive(0, 10), archive(1, 32)])).toBe(42);
    });
});
