import { describe, expect, it } from "vitest";
import {
    NO_SCHEDULE,
    readSchedule,
    scheduleAction,
    scheduleModeAt,
    windowCovers,
    zonedMoment,
    type GameSchedule
} from "@/lib/apps/minecraft/schedule";

/** The rule everybody actually asks for: quiet overnight, up the rest of the day. */
const OVERNIGHT: GameSchedule = {
    enabled: true,
    timezone: "Europe/Madrid",
    otherwise: "on",
    idleMinutes: 30,
    windows: [{ days: [], from: "00:00", to: "10:00", mode: "sleep" }]
};

describe("zonedMoment", () => {
    it("reads the time where the players are, not where the machine is", () => {
        // Saturday 23:30 UTC is already Sunday in Madrid, and Sunday is the day
        // the overnight window has to be judged on there.
        const at = new Date("2026-08-08T23:30:00Z");
        expect(zonedMoment(at, "Europe/Madrid")).toEqual({ day: 0, minutes: 90 });
        expect(zonedMoment(at, "UTC")).toEqual({ day: 6, minutes: 23 * 60 + 30 });
    });
});

describe("windowCovers", () => {
    const evening = { days: [5], from: "23:00", to: "06:00", mode: "sleep" as const };

    it("covers the evening half on the day it names", () => {
        expect(windowCovers(evening, 5, 23 * 60 + 30)).toBe(true);
    });

    it("covers the morning half on the day after", () => {
        expect(windowCovers(evening, 6, 2 * 60)).toBe(true);
    });

    it("does not cover the same morning it started on", () => {
        expect(windowCovers(evening, 5, 2 * 60)).toBe(false);
    });

    it("covers every day when no day is named", () => {
        const daily = { days: [], from: "09:00", to: "17:00", mode: "on" as const };
        expect([0, 3, 6].every((day) => windowCovers(daily, day, 10 * 60))).toBe(true);
    });

    it("ends exactly when it says it does", () => {
        const daily = { days: [], from: "09:00", to: "17:00", mode: "on" as const };
        expect(windowCovers(daily, 1, 17 * 60)).toBe(false);
        expect(windowCovers(daily, 1, 17 * 60 - 1)).toBe(true);
    });
});

describe("scheduleModeAt", () => {
    it("sleeps inside the overnight window and runs outside it", () => {
        expect(scheduleModeAt(OVERNIGHT, new Date("2026-08-08T01:00:00Z"))).toBe("sleep");
        expect(scheduleModeAt(OVERNIGHT, new Date("2026-08-08T12:00:00Z"))).toBe("on");
    });

    it("lets a later window override an earlier one", () => {
        const schedule: GameSchedule = {
            ...OVERNIGHT,
            windows: [
                { days: [], from: "00:00", to: "10:00", mode: "sleep" },
                { days: [6], from: "00:00", to: "10:00", mode: "on" }
            ]
        };
        // Saturday morning in Madrid; the weekend rule was written second.
        expect(scheduleModeAt(schedule, new Date("2026-08-08T06:00:00Z"))).toBe("on");
    });

    it("asks for nothing at all while it is switched off", () => {
        expect(scheduleModeAt({ ...OVERNIGHT, enabled: false }, new Date("2026-08-08T01:00:00Z"))).toBe("on");
    });
});

describe("scheduleAction", () => {
    const asleep = new Date("2026-08-08T01:00:00Z");
    const awake = new Date("2026-08-08T12:00:00Z");

    it("starts a stopped server inside a window that says on", () => {
        expect(scheduleAction(OVERNIGHT, awake, { running: false, playersOnline: 0, emptySince: null })).toBe("start");
    });

    it("leaves a running server alone inside a window that says on", () => {
        expect(scheduleAction(OVERNIGHT, awake, { running: true, playersOnline: 0, emptySince: null })).toBe(null);
    });

    it("stops a server that has been empty long enough", () => {
        const emptySince = new Date(asleep.getTime() - 31 * 60_000).toISOString();
        expect(scheduleAction(OVERNIGHT, asleep, { running: true, playersOnline: 0, emptySince })).toBe("stop");
    });

    it("waits out the idle time before stopping", () => {
        const emptySince = new Date(asleep.getTime() - 5 * 60_000).toISOString();
        expect(scheduleAction(OVERNIGHT, asleep, { running: true, playersOnline: 0, emptySince })).toBe(null);
    });

    it("never stops a server somebody is playing on", () => {
        const emptySince = new Date(asleep.getTime() - 10 * 3_600_000).toISOString();
        expect(scheduleAction(OVERNIGHT, asleep, { running: true, playersOnline: 2, emptySince })).toBe(null);
    });

    it("does not wake a sleeping server just to find it empty again", () => {
        expect(scheduleAction(OVERNIGHT, asleep, { running: false, playersOnline: 0, emptySince: null })).toBe(null);
    });

    it("stops a running server in a window that says off, whoever is on", () => {
        const closed: GameSchedule = { ...OVERNIGHT, windows: [{ days: [], from: "00:00", to: "10:00", mode: "off" }] };
        expect(scheduleAction(closed, asleep, { running: true, playersOnline: 3, emptySince: null })).toBe("stop");
    });

    it("does nothing at all while it is switched off", () => {
        const off = { ...OVERNIGHT, enabled: false };
        expect(scheduleAction(off, awake, { running: false, playersOnline: 0, emptySince: null })).toBe(null);
    });
});

describe("readSchedule", () => {
    it("reads back what the screen wrote", () => {
        const stored = { schedule: OVERNIGHT } as unknown as Record<string, unknown>;
        expect(readSchedule(stored)).toEqual(OVERNIGHT);
    });

    it("falls back rather than throwing over a blob written by hand", () => {
        expect(readSchedule({ schedule: "nonsense" })).toEqual(NO_SCHEDULE);
        expect(readSchedule({})).toEqual(NO_SCHEDULE);
    });

    it("drops a window whose times are not times, keeping the rest", () => {
        const read = readSchedule({
            schedule: {
                enabled: true,
                timezone: "UTC",
                otherwise: "on",
                idleMinutes: 30,
                windows: [
                    { days: [], from: "25:00", to: "10:00", mode: "sleep" },
                    { days: [1], from: "09:00", to: "17:00", mode: "on" }
                ]
            }
        });
        expect(read.windows).toEqual([{ days: [1], from: "09:00", to: "17:00", mode: "on" }]);
    });

    it("holds the idle time to something a sleep can actually mean", () => {
        expect(readSchedule({ schedule: { idleMinutes: 1 } }).idleMinutes).toBe(5);
        expect(readSchedule({ schedule: { idleMinutes: 99_999 } }).idleMinutes).toBe(24 * 60);
    });
});
