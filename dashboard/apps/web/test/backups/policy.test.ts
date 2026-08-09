/**
 * Schedule and retention.
 *
 * These are the rules that decide whether a backup happens and which copies stop
 * existing, so they are tested as arithmetic rather than through the engine: a
 * retention bug does not throw, it deletes.
 *
 * The generalization of the Minecraft world policy this replaces, so its two
 * hardest-won behaviours are asserted here as well - due-ness is measured from
 * what exists rather than from a recorded run, and the last surviving copy is
 * never proposed for deletion whatever the limits say.
 */

import { describe, expect, it } from "vitest";
import {
    backupDue,
    copiesToPrune,
    DEFAULT_POLICY,
    expiresAt,
    nextBackupAt,
    readPolicy,
    totalBytes,
    type RetainableCopy,
    type RetentionPolicy
} from "@/lib/backups/policy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
    return { ...DEFAULT_POLICY, every: "daily", keepLast: 0, keepDays: 0, maxBytes: 0, ...overrides };
}

function copy(id: string, agoDays: number, sizeBytes = 100, now = Date.now()): RetainableCopy {
    return { id, sizeBytes, takenAt: new Date(now - agoDays * DAY) };
}

describe("when a copy is due", () => {
    const now = new Date("2026-08-09T12:00:00Z");

    it("never runs while the schedule is off", () => {
        expect(backupDue(policy({ every: "off" }), null, now)).toBe(false);
    });

    it("runs immediately when nothing has ever been taken", () => {
        expect(backupDue(policy({ every: "weekly" }), null, now)).toBe(true);
    });

    it("measures from the newest copy, not from a recorded run", () => {
        const justNow = new Date(now.getTime() - HOUR);
        const yesterday = new Date(now.getTime() - 25 * HOUR);
        expect(backupDue(policy({ every: "daily" }), justNow, now)).toBe(false);
        expect(backupDue(policy({ every: "daily" }), yesterday, now)).toBe(true);
    });

    it("treats the interval as reached, not merely passed", () => {
        const exactly = new Date(now.getTime() - HOUR);
        expect(backupDue(policy({ every: "hourly" }), exactly, now)).toBe(true);
    });

    it("says when the next one lands, and nothing when it is off", () => {
        const newest = new Date(now.getTime() - HOUR);
        expect(nextBackupAt(policy({ every: "six-hourly" }), newest, now)?.toISOString()).toBe(
            new Date(newest.getTime() + 6 * HOUR).toISOString()
        );
        expect(nextBackupAt(policy({ every: "off" }), newest, now)).toBeNull();
        // Never taken: due now rather than at some point in the past.
        expect(nextBackupAt(policy({ every: "daily" }), null, now)?.toISOString()).toBe(now.toISOString());
    });
});

describe("retention", () => {
    it("proposes nothing when there is one copy or none", () => {
        expect(copiesToPrune([], policy({ keepLast: 1 }))).toEqual([]);
        expect(copiesToPrune([copy("a", 400)], policy({ keepLast: 1, keepDays: 1 }))).toEqual([]);
    });

    it("keeps the newest N and drops the rest oldest first", () => {
        const copies = [copy("new", 0), copy("mid", 1), copy("old", 2), copy("ancient", 3)];
        expect(copiesToPrune(copies, policy({ keepLast: 2 }))).toEqual(["ancient", "old"]);
    });

    it("drops anything past its age, independently of the count", () => {
        const copies = [copy("new", 0), copy("old", 40), copy("older", 90)];
        expect(copiesToPrune(copies, policy({ keepDays: 30 }))).toEqual(["older", "old"]);
    });

    it("enforces a byte budget by dropping the oldest until it fits", () => {
        const copies = [copy("new", 0, 60), copy("mid", 1, 60), copy("old", 2, 60)];
        // 120 fits two of them; the third is over.
        expect(copiesToPrune(copies, policy({ maxBytes: 120 }))).toEqual(["old"]);
    });

    it("lets the strictest limit bite first when several are on", () => {
        const copies = [copy("new", 0, 60), copy("mid", 1, 60), copy("old", 2, 60), copy("ancient", 40, 60)];
        const strict = policy({ keepLast: 3, keepDays: 30, maxBytes: 120 });
        // keepLast would keep three, the budget keeps two, the age kills the
        // fourth outright - so two survive.
        expect(copiesToPrune(copies, strict)).toEqual(["ancient", "old"]);
    });

    it("never proposes the last surviving copy, however small the budget", () => {
        const copies = [copy("new", 0, 5_000), copy("old", 1, 5_000)];
        // A budget smaller than one copy would otherwise resolve to deleting
        // everything - the exact outcome backups exist to prevent.
        expect(copiesToPrune(copies, policy({ maxBytes: 1 }))).toEqual(["old"]);
        expect(copiesToPrune(copies, policy({ keepLast: 0, keepDays: 1, maxBytes: 1 }))).not.toContain("new");
    });

    it("never proposes the newest even when it is older than the age limit", () => {
        const copies = [copy("new", 100), copy("old", 200)];
        expect(copiesToPrune(copies, policy({ keepDays: 30 }))).toEqual(["old"]);
    });

    it("dates a copy's expiry only when age is a limit", () => {
        const at = new Date("2026-08-09T00:00:00Z");
        expect(expiresAt(policy({ keepDays: 0 }), at)).toBeNull();
        expect(expiresAt(policy({ keepDays: 7 }), at)?.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    });

    it("adds up what the copies take", () => {
        expect(totalBytes([{ sizeBytes: 10 }, { sizeBytes: 32 }])).toBe(42);
    });
});

describe("reading a stored plan", () => {
    it("falls back field by field rather than rejecting the row whole", () => {
        // A row somebody hand-edited must degrade to the default schedule, not to
        // no backups at all without saying so.
        const read = readPolicy({ every: "fortnightly", keepLast: -5, keepDays: 1.7, notifyOnFailure: "yes" });
        expect(read.every).toBe(DEFAULT_POLICY.every);
        expect(read.keepLast).toBe(0);
        expect(read.keepDays).toBe(1);
        expect(read.notifyOnFailure).toBe(DEFAULT_POLICY.notifyOnFailure);
    });

    it("accepts the BigInt the budget column stores", () => {
        expect(readPolicy({ every: "daily", maxBytes: 4_294_967_296n }).maxBytes).toBe(4_294_967_296);
    });

    it("clamps a budget nobody could have meant", () => {
        expect(readPolicy({ maxBytes: Number.MAX_SAFE_INTEGER }).maxBytes).toBe(2 * 1024 ** 4);
    });
});
