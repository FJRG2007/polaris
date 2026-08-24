/**
 * The wait between handle changes.
 *
 * Every case here is a clock, which is exactly why the rule is a pure function:
 * "can they change it yet" tested against a real database and a real `now` is a
 * test that passes in the morning and fails after a clock change.
 *
 * The two that matter most are at the ends. An account that has never changed
 * its handle must not be serving a wait - every account that existed before this
 * rule has a null column, and a retroactive punishment for something nobody was
 * told about is the worst version of this feature. And a wait of zero must
 * actually mean none, because a deployment where everybody knows each other has
 * no problem here to solve.
 */

import { describe, expect, it } from "vitest";
import {
    usernameChangeAllowed,
    usernameChangeAllowedAt,
    usernameChangeRefusal,
    usernameCooldownDays,
    usernameCooldownRemaining,
    USERNAME_COOLDOWN_DAYS,
    USERNAME_COOLDOWN_MAX_DAYS
} from "./username-cooldown.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-24T12:00:00.000Z");

/** A moment `days` before NOW. */
function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * DAY);
}

describe("an account that has never changed its handle", () => {
    it("may change it now", () => {
        expect(usernameChangeAllowed(null, NOW)).toBe(true);
        expect(usernameChangeAllowedAt(null)).toBeNull();
        expect(usernameChangeRefusal(null, NOW)).toBeNull();
    });

    it("is not serving a wait it was never told about", () => {
        // Every account that existed before this rule has a null column.
        expect(usernameChangeRefusal(undefined, NOW)).toBeNull();
    });
});

describe("an account that changed it recently", () => {
    it("is refused, and told how long is left", () => {
        const refusal = usernameChangeRefusal(daysAgo(1), NOW);
        expect(refusal).toContain("29 days");
    });

    it("is refused right up to the last moment", () => {
        // One minute short of the full wait is still short of it.
        const almost = new Date(NOW.getTime() - USERNAME_COOLDOWN_DAYS * DAY + 60_000);
        expect(usernameChangeAllowed(almost, NOW)).toBe(false);
    });

    it("is allowed the moment the wait is up, not a day after", () => {
        const exactly = new Date(NOW.getTime() - USERNAME_COOLDOWN_DAYS * DAY);
        expect(usernameChangeAllowed(exactly, NOW)).toBe(true);
        expect(usernameChangeRefusal(exactly, NOW)).toBeNull();
    });

    it("is allowed once the wait has long passed", () => {
        expect(usernameChangeAllowed(daysAgo(400), NOW)).toBe(true);
    });
});

describe("how long is left, said out loud", () => {
    it("rounds up rather than down", () => {
        // Eleven hours left must never read as "0 days".
        const allowedAt = new Date(NOW.getTime() + 11 * 60 * 60 * 1000);
        expect(usernameCooldownRemaining(allowedAt, NOW)).toBe("11 hours");
    });

    it("counts in minutes under the hour", () => {
        expect(usernameCooldownRemaining(new Date(NOW.getTime() + 90_000), NOW)).toBe("2 minutes");
    });

    it("says one of a thing without the number reading oddly", () => {
        expect(usernameCooldownRemaining(new Date(NOW.getTime() + 60_000), NOW)).toBe("1 minute");
        expect(usernameCooldownRemaining(new Date(NOW.getTime() + 60 * 60_000), NOW)).toBe("1 hour");
        expect(usernameCooldownRemaining(new Date(NOW.getTime() + DAY), NOW)).toBe("1 day");
    });

    it("says now for a moment that has already passed", () => {
        expect(usernameCooldownRemaining(daysAgo(1), NOW)).toBe("now");
    });
});

describe("a wait of zero", () => {
    it("means no wait at all, however recently they changed it", () => {
        expect(usernameChangeAllowed(daysAgo(0), NOW, 0)).toBe(true);
        expect(usernameChangeAllowedAt(daysAgo(0), 0)).toBeNull();
        expect(usernameChangeRefusal(daysAgo(0), NOW, 0)).toBeNull();
    });
});

describe("reading the operator's stored value", () => {
    it("falls back to the default when nothing is stored", () => {
        expect(usernameCooldownDays(null)).toBe(USERNAME_COOLDOWN_DAYS);
        expect(usernameCooldownDays(undefined)).toBe(USERNAME_COOLDOWN_DAYS);
        expect(usernameCooldownDays("")).toBe(USERNAME_COOLDOWN_DAYS);
    });

    it("takes a number an operator actually set", () => {
        expect(usernameCooldownDays("7")).toBe(7);
    });

    it("honours zero rather than treating it as unset", () => {
        // The bug this exists to prevent: `stored || DEFAULT` would turn the
        // operator's deliberate "no wait" back into thirty days.
        expect(usernameCooldownDays("0")).toBe(0);
    });

    it("falls back rather than trusting nonsense", () => {
        expect(usernameCooldownDays("soon")).toBe(USERNAME_COOLDOWN_DAYS);
        expect(usernameCooldownDays("-5")).toBe(USERNAME_COOLDOWN_DAYS);
    });

    it("caps a value that would lock every handle for a decade", () => {
        expect(usernameCooldownDays("99999")).toBe(USERNAME_COOLDOWN_MAX_DAYS);
    });
});
