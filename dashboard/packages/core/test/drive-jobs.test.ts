/**
 * How far along a long Drive job is.
 *
 * The point of all of it is that a bar with no number beside it is
 * indistinguishable from a hang, which is why people press the button again. So
 * what is asserted here is what the reader is told - and, as much, what they are
 * deliberately not told: an estimate made from one file's worth of evidence is
 * worse than none, because it swings and people plan around it.
 */

import { describe, expect, it } from "vitest";
import {
    driveJobEta,
    driveJobFraction,
    driveJobRemainingMs,
    driveJobSummary,
    type DriveJobProgress
} from "../src/drive-jobs.js";

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const startedAgo = (ms: number): string => new Date(NOW - ms).toISOString();

const job = (over: Partial<DriveJobProgress> = {}): DriveJobProgress => ({
    total: 100,
    done: 0,
    failed: 0,
    state: "running",
    startedAt: startedAgo(60_000),
    ...over
});

describe("how much is behind us", () => {
    it("is the fraction done", () => {
        expect(driveJobFraction({ total: 200, done: 50 })).toBe(0.25);
        expect(driveJobFraction({ total: 200, done: 200 })).toBe(1);
    });

    it("is finished rather than divided by zero when there was nothing to do", () => {
        expect(driveJobFraction({ total: 0, done: 0 })).toBe(1);
    });

    it("never leaves the range, whatever the counters say", () => {
        expect(driveJobFraction({ total: 10, done: 40 })).toBe(1);
        expect(driveJobFraction({ total: 10, done: -5 })).toBe(0);
    });
});

describe("how long is left", () => {
    it("extrapolates from the rate so far", () => {
        // A quarter done in a minute is three more minutes.
        const remaining = driveJobRemainingMs(
            { total: 100, done: 25, startedAt: startedAgo(60_000) },
            NOW
        );
        expect(remaining).toBe(180_000);
    });

    it("says nothing before there is a rate to extrapolate from", () => {
        expect(
            driveJobRemainingMs({ total: 100, done: 0, startedAt: startedAgo(60_000) }, NOW)
        ).toBeNull();
        expect(driveJobRemainingMs({ total: 100, done: 10, startedAt: null }, NOW)).toBeNull();
    });

    it("says nothing in the first seconds, when one slow file decides everything", () => {
        // The same job a second in would claim over an hour and then change its
        // mind, which is worse than not answering.
        expect(
            driveJobRemainingMs({ total: 5000, done: 1, startedAt: startedAgo(900) }, NOW)
        ).toBeNull();
    });

    it("says nothing once it is done", () => {
        expect(
            driveJobRemainingMs({ total: 100, done: 100, startedAt: startedAgo(60_000) }, NOW)
        ).toBeNull();
    });
});

describe("how it is worded", () => {
    it("rounds to something nobody would check", () => {
        expect(driveJobEta(20_000)).toBe("less than a minute left");
        // Half a minute rounds up to one rather than down to none: "less than a
        // minute" on something with thirty seconds to go reads as nearly over.
        expect(driveJobEta(30_000)).toBe("about a minute left");
        expect(driveJobEta(61_000)).toBe("about a minute left");
        expect(driveJobEta(9 * 60_000)).toBe("about 9 minutes left");
        expect(driveJobEta(62 * 60_000)).toBe("about an hour left");
        expect(driveJobEta(3 * 60 * 60_000)).toBe("about 3 hours left");
    });

    it("says nothing when there is nothing to say", () => {
        expect(driveJobEta(null)).toBeNull();
    });
});

describe("the line under the label", () => {
    it("leads with the count, because that is the question", () => {
        expect(driveJobSummary(job({ done: 25 }), NOW)).toBe("25 of 100 - about 3 minutes left");
    });

    it("leaves the failures out when there are none", () => {
        expect(driveJobSummary(job({ done: 25 }), NOW)).not.toContain("failed");
    });

    it("names them when there are", () => {
        expect(driveJobSummary(job({ done: 25, failed: 2 }), NOW)).toContain("2 failed");
    });

    it("reads as an outcome once it is over", () => {
        expect(driveJobSummary(job({ done: 100, state: "finished" }), NOW)).toBe("100 done");
        expect(driveJobSummary(job({ done: 94, failed: 6, state: "finished" }), NOW)).toBe(
            "94 of 100 done, 6 could not be"
        );
    });

    it("says where it got to when somebody stopped it", () => {
        expect(driveJobSummary(job({ done: 40, state: "cancelled" }), NOW)).toBe(
            "Stopped after 40 of 100"
        );
    });
});
