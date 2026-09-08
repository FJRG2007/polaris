/**
 * Whether a grant is in force.
 *
 * This is the whole of the security of a shared door: everything above it -
 * screens, routes, drivers - asks this one question and does what it says. The
 * interesting failure here is not "somebody was refused", it is "somebody was
 * let in", so the cases below are mostly the ones that should say no.
 *
 * The hours are `weeklyWindow`, shared with standing hours, so the arithmetic of
 * a window that crosses midnight and of the night the clocks move is pinned by
 * that module's own tests as well. What is pinned here is how the three bounds
 * compose, and the order they are reported in.
 */

import { describe, expect, it } from "vitest";
import { EVERY_DAY, dayBit, weekOrderFrom } from "./schemas/presence-schedule.js";
import {
    atLeast,
    describeGrant,
    grantIsBounded,
    grantIsLive,
    judgeGrant,
    strongest,
    type GrantSchedule
} from "./access-grants.js";

/** A grant with nothing bounding it, which is what most of them are. */
const OPEN: GrantSchedule = {
    startsAt: null,
    endsAt: null,
    days: EVERY_DAY,
    startMinute: null,
    endMinute: null,
    timeZone: "UTC",
    maxUses: null,
    uses: 0
};

/** A Wednesday, in the middle of the afternoon, UTC. */
const AFTERNOON = new Date("2026-09-09T14:00:00Z");

function at(hours: number, minutes = 0): Date {
    return new Date(Date.UTC(2026, 8, 9, hours, minutes));
}

describe("a grant with no bounds", () => {
    it("is in force whenever it is asked about", () => {
        expect(judgeGrant(OPEN, AFTERNOON)).toEqual({ standing: "live", until: null });
        expect(grantIsLive(OPEN, at(3))).toBe(true);
    });

    it("reads as unbounded, so a screen knows there is nothing to print", () => {
        expect(grantIsBounded(OPEN)).toBe(false);
        expect(describeGrant(OPEN, weekOrderFrom(1), () => "")).toBe("");
    });
});

describe("dates", () => {
    it("is not in force before its first day", () => {
        const grant = { ...OPEN, startsAt: new Date("2026-09-10T00:00:00Z") };
        expect(judgeGrant(grant, AFTERNOON).standing).toBe("waiting");
    });

    it("is not in force after its last", () => {
        const grant = { ...OPEN, endsAt: new Date("2026-09-08T00:00:00Z") };
        expect(judgeGrant(grant, AFTERNOON).standing).toBe("expired");
    });

    it("is in force between them, and says when it runs out", () => {
        const endsAt = new Date("2026-09-30T00:00:00Z");
        const grant = { ...OPEN, startsAt: new Date("2026-09-01T00:00:00Z"), endsAt };
        expect(judgeGrant(grant, AFTERNOON)).toEqual({ standing: "live", until: endsAt });
    });
});

describe("hours", () => {
    const NINE_TO_ELEVEN: GrantSchedule = {
        ...OPEN,
        startMinute: 9 * 60,
        endMinute: 11 * 60
    };

    it("opens and shuts on the clock", () => {
        expect(judgeGrant(NINE_TO_ELEVEN, at(8, 59)).standing).toBe("closed");
        expect(judgeGrant(NINE_TO_ELEVEN, at(9, 0)).standing).toBe("live");
        expect(judgeGrant(NINE_TO_ELEVEN, at(10, 59)).standing).toBe("live");
        expect(judgeGrant(NINE_TO_ELEVEN, at(11, 0)).standing).toBe("closed");
    });

    it("says when the window shuts, which is what a screen shows as until", () => {
        expect(judgeGrant(NINE_TO_ELEVEN, at(9, 30)).until).toEqual(at(11, 0));
    });

    it("stops at the last day rather than at the hour when that comes first", () => {
        // The grant ends at ten; the window would otherwise run to eleven.
        const endsAt = at(10, 0);
        expect(judgeGrant({ ...NINE_TO_ELEVEN, endsAt }, at(9, 30)).until).toEqual(endsAt);
    });

    it("crosses midnight rather than lasting no time", () => {
        // 23:00 to 07:00 is the whole reason anybody wants hours, and at one in
        // the morning it is yesterday's window that is open.
        const night: GrantSchedule = { ...OPEN, startMinute: 23 * 60, endMinute: 7 * 60 };
        expect(judgeGrant(night, at(1, 0)).standing).toBe("live");
        expect(judgeGrant(night, at(23, 30)).standing).toBe("live");
        expect(judgeGrant(night, at(12, 0)).standing).toBe("closed");
    });
});

describe("days", () => {
    // 2026-09-09 is a Wednesday, which is day 3.
    const WEDNESDAY = dayBit(3);

    it("opens only on the days it names, with no hours given", () => {
        expect(judgeGrant({ ...OPEN, days: WEDNESDAY }, AFTERNOON).standing).toBe("live");
        expect(judgeGrant({ ...OPEN, days: dayBit(4) }, AFTERNOON).standing).toBe("closed");
    });

    it("narrows the hours to those days when both are given", () => {
        const tuesdays: GrantSchedule = {
            ...OPEN,
            days: dayBit(2),
            startMinute: 9 * 60,
            endMinute: 11 * 60
        };
        // The right hour on the wrong day is still no.
        expect(judgeGrant(tuesdays, at(10, 0)).standing).toBe("closed");
    });
});

describe("uses", () => {
    it("is spent when it has none left", () => {
        expect(judgeGrant({ ...OPEN, maxUses: 4, uses: 4 }, AFTERNOON).standing).toBe("spent");
    });

    it("is in force while it has some", () => {
        expect(judgeGrant({ ...OPEN, maxUses: 4, uses: 3 }, AFTERNOON).standing).toBe("live");
    });

    it("says it is used up rather than complaining about the hour", () => {
        // The order the answers are tried in is the order somebody wants to be
        // told: "you have none left" is the useful sentence, and "it is not nine
        // yet" sends them back at nine to be refused again.
        const spent: GrantSchedule = {
            ...OPEN,
            startMinute: 9 * 60,
            endMinute: 11 * 60,
            maxUses: 1,
            uses: 1
        };
        expect(judgeGrant(spent, at(3, 0)).standing).toBe("spent");
    });
});

describe("what a grant hands over", () => {
    it("answers a weaker ask with a stronger holding", () => {
        expect(atLeast("place.device", "control", "view")).toBe(true);
        expect(atLeast("place.device", "view", "control")).toBe(false);
        expect(atLeast("task.space", "admin", "guest")).toBe(true);
    });

    it("never answers yes to a word that is not in the ladder", () => {
        // A capability from another subject, or one from a build that has moved
        // on. The safe way to be wrong about a word nobody recognises is no.
        expect(atLeast("place.device", "admin", "view")).toBe(false);
        expect(atLeast("chat.space", "control", "member")).toBe(false);
    });

    it("picks the strongest of several, and nothing out of none", () => {
        expect(strongest("task.space", ["guest", "admin", "member"])).toBe("admin");
        expect(strongest("place.device", [])).toBe("");
        expect(strongest("place.device", ["nonsense"])).toBe("");
    });
});

describe("what a grant says on screen", () => {
    it("names only the bounds it has", () => {
        const grant: GrantSchedule = {
            ...OPEN,
            days: dayBit(2) | dayBit(4),
            startMinute: 9 * 60,
            endMinute: 11 * 60,
            maxUses: 10,
            uses: 4
        };
        expect(describeGrant(grant, weekOrderFrom(1), () => "")).toBe(
            "Tue, Thu - 09:00 to 11:00 - 4 of 10 uses"
        );
    });

    it("says a date range the way somebody would", () => {
        const grant: GrantSchedule = {
            ...OPEN,
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2026-09-30T00:00:00Z")
        };
        expect(describeGrant(grant, weekOrderFrom(1), (date) => date.toISOString().slice(0, 10))).toBe(
            "2026-09-01 to 2026-09-30"
        );
    });
});
