/**
 * The part of the week somebody wrote down once.
 *
 * Three things are asserted here rather than left to a comment, because all
 * three are the kind of rule that quietly stops holding and none of them fails
 * loudly when it does - a schedule that has stopped working looks exactly like a
 * schedule nobody set.
 *
 * 1. A window is a wall-clock rule read on the account's own clock, so the same
 *    row means midnight in Madrid and midnight in Auckland.
 * 2. A window that ends before it starts crosses midnight, and the days it names
 *    are the days it opens on.
 * 3. A window takes over when it opens, and anything chosen inside one is the
 *    account's until it closes. That is the whole of the precedence rule, and
 *    the half nobody would think to test is the second: without it, "make me
 *    visible again" at one in the morning does nothing at all.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

/** A Thursday, and the numbers below are all read against it. */
const THURSDAY = new Date("2026-08-20T12:00:00Z");

function rule(over: Partial<core.PresenceScheduleRule> = {}): core.PresenceScheduleRule {
    return {
        id: "night",
        presence: "invisible",
        days: core.EVERY_DAY,
        startMinute: 23 * 60,
        endMinute: 7 * 60,
        enabled: true,
        ...over
    };
}

/** What the account looks like before anybody has chosen anything. */
const UNTOUCHED = { presence: "auto", presenceUntil: null, presenceSetAt: null };

describe("a window on the account's own clock", () => {
    it("opens at the hour it names, wherever that account is", () => {
        const overnight = [rule()];
        // 23:30 in Madrid, which is 21:30 UTC.
        const open = core.openWindow(overnight, "Europe/Madrid", new Date("2026-08-20T21:30:00Z"));
        expect(open?.rule.id).toBe("night");

        // The same instant is 22:30 in London, still half an hour short.
        expect(core.openWindow(overnight, "Europe/London", new Date("2026-08-20T21:30:00Z"))).toBeNull();
    });

    it("closes at the hour it names rather than a length after it opened", () => {
        const open = core.openWindow([rule()], "Europe/Madrid", new Date("2026-08-20T21:30:00Z"));
        // 07:00 the next morning, Madrid, which is 05:00 UTC.
        expect(open?.closesAt.toISOString()).toBe("2026-08-21T05:00:00.000Z");
    });
});

describe("a window that crosses midnight", () => {
    const fridayNights = [rule({ days: core.dayBit(5) })];

    it("is open in the small hours of the day after the one it names", () => {
        // Saturday at 01:00 UTC, from a window that only names Friday.
        const open = core.openWindow(fridayNights, "UTC", new Date("2026-08-22T01:00:00Z"));
        expect(open?.rule.id).toBe("night");
    });

    it("is not open in the small hours of the day it names", () => {
        // Friday at 01:00 - the window this rule opens is tonight, not last
        // night, because Thursday is not one of its days.
        expect(core.openWindow(fridayNights, "UTC", new Date("2026-08-21T01:00:00Z"))).toBeNull();
    });
});

describe("two windows over the same hour", () => {
    it("hands it to the one that opened most recently", () => {
        const allDay = rule({ id: "day", presence: "away", startMinute: 9 * 60, endMinute: 18 * 60 });
        const afternoon = rule({ id: "focus", presence: "busy", startMinute: 14 * 60, endMinute: 16 * 60 });
        const open = core.openWindow([allDay, afternoon], "UTC", new Date("2026-08-20T15:00:00Z"));
        expect(open?.rule.id).toBe("focus");
    });
});

describe("a window that is switched off", () => {
    it("is kept and not applied", () => {
        const off = [rule({ enabled: false, startMinute: 0, endMinute: 23 * 60 })];
        expect(core.openWindow(off, "UTC", THURSDAY)).toBeNull();
    });
});

describe("what the account actually appears as", () => {
    const overnight = [rule({ startMinute: 0, endMinute: 9 * 60 })];
    const smallHours = new Date("2026-08-20T02:00:00Z");

    it("is the window's answer for somebody who has chosen nothing", () => {
        const held = core.presenceInForce(UNTOUCHED, overnight, "UTC", smallHours);
        expect(held).toEqual({
            choice: "invisible",
            until: new Date("2026-08-20T09:00:00Z"),
            scheduled: true
        });
    });

    it("is the window's answer over a choice made before it opened", () => {
        const held = core.presenceInForce(
            {
                presence: "busy",
                presenceUntil: null,
                // Yesterday afternoon, and never cleared.
                presenceSetAt: new Date("2026-08-19T16:00:00Z")
            },
            overnight,
            "UTC",
            smallHours
        );
        expect(held.choice).toBe("invisible");
        expect(held.scheduled).toBe(true);
    });

    it("is the person's answer when they chose inside the window", () => {
        // The case the whole `presenceSetAt` column exists for: somebody awake
        // at two in the morning who wants to be seen. Choosing `auto` has to
        // win, which is why the comparison is on the moment and never on the
        // value.
        const held = core.presenceInForce(
            {
                presence: "auto",
                presenceUntil: null,
                presenceSetAt: new Date("2026-08-20T01:30:00Z")
            },
            overnight,
            "UTC",
            smallHours
        );
        expect(held).toEqual({ choice: "auto", until: null, scheduled: false });
    });

    it("goes back to the choice that was standing once the window closes", () => {
        const held = core.presenceInForce(
            {
                presence: "busy",
                presenceUntil: null,
                presenceSetAt: new Date("2026-08-19T16:00:00Z")
            },
            overnight,
            "UTC",
            // Ten in the morning, an hour after it shut.
            new Date("2026-08-20T10:00:00Z")
        );
        expect(held).toEqual({ choice: "busy", until: null, scheduled: false });
    });

    it("treats a choice whose own window has passed as no choice at all", () => {
        const held = core.presenceInForce(
            {
                presence: "busy",
                presenceUntil: new Date("2026-08-20T09:30:00Z"),
                presenceSetAt: new Date("2026-08-20T09:00:00Z")
            },
            overnight,
            "UTC",
            new Date("2026-08-20T10:00:00Z")
        );
        expect(held).toEqual({ choice: "auto", until: null, scheduled: false });
    });
});

describe("what a window is refused for", () => {
    it("no days, because it would never open", () => {
        const written = core.presenceScheduleSchema.safeParse({
            presence: "away",
            days: 0,
            startMinute: 0,
            endMinute: 60,
            enabled: true
        });
        expect(written.success).toBe(false);
    });

    it("an end at the minute it starts, which is both nothing and everything", () => {
        const written = core.presenceScheduleSchema.safeParse({
            presence: "away",
            days: core.EVERY_DAY,
            startMinute: 540,
            endMinute: 540,
            enabled: true
        });
        expect(written.success).toBe(false);
    });

    it("a mode that is not one, `auto` included", () => {
        for (const presence of ["auto", "online", ""]) {
            const written = core.presenceScheduleSchema.safeParse({
                presence,
                days: core.EVERY_DAY,
                startMinute: 0,
                endMinute: 60,
                enabled: true
            });
            expect(written.success).toBe(false);
        }
    });
});

describe("the days, in words", () => {
    const fromSunday = core.weekOrderFrom(0);

    it("names the sets people actually mean", () => {
        expect(core.nameDays(core.EVERY_DAY, fromSunday)).toBe("Every day");
        expect(core.nameDays(core.WEEKDAYS, fromSunday)).toBe("Weekdays");
        expect(core.nameDays(core.WEEKEND, fromSunday)).toBe("Weekends");
    });

    it("lists anything else in the order this account's week runs", () => {
        const monWedFri = core.dayBit(1) | core.dayBit(3) | core.dayBit(5);
        expect(core.nameDays(monWedFri, fromSunday)).toBe("Mon, Wed, Fri");
        // The same three days for somebody whose week starts on Saturday.
        expect(core.nameDays(monWedFri, core.weekOrderFrom(6))).toBe("Mon, Wed, Fri");
    });
});

describe("a window picked as an exact moment", () => {
    it("is stored as the moment, not as a length", () => {
        const at = new Date(THURSDAY.getTime() + 90 * 60_000);
        expect(core.windowEndsAt({ until: at.toISOString() }, THURSDAY)).toEqual(at);
    });

    it("is refused when it has passed or reaches past a year", () => {
        expect(core.isWindowMoment(new Date(THURSDAY.getTime() - 1000).toISOString(), THURSDAY)).toBe(false);
        expect(core.isWindowMoment("not a date", THURSDAY)).toBe(false);
        expect(
            core.isWindowMoment(
                new Date(THURSDAY.getTime() + core.MAX_WINDOW_MS + 60_000).toISOString(),
                THURSDAY
            )
        ).toBe(false);
        expect(core.isWindowMoment(new Date(THURSDAY.getTime() + 60_000).toISOString(), THURSDAY)).toBe(true);
    });

    it("is nothing at all when neither half was given", () => {
        expect(core.windowEndsAt({}, THURSDAY)).toBeNull();
        expect(core.windowEndsAt({ minutes: null }, THURSDAY)).toBeNull();
    });
});
