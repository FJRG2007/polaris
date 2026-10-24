/**
 * The Advanced section's value as every link's schema takes it: a day's expiry
 * ends with that day in the reader's time, and a password is only sent, or taken
 * off, when the owner asked.
 */

import { describe, expect, it } from "vitest";
import {
    EMPTY_LINK_ADVANCED,
    linkExpiry,
    linkExpiryDay,
    linkGuardFields,
    linkHoursIncomplete,
    linkLimits,
    linkSchedule,
    NO_LINK_GUARDS
} from "@/components/link-advanced-fields";

describe("the Advanced section's limits", () => {
    it("ends an expiry day at its last moment, in local time", () => {
        const end = linkExpiry("2026-03-14");
        expect(end?.getFullYear()).toBe(2026);
        expect(end?.getMonth()).toBe(2);
        expect(end?.getDate()).toBe(14);
        expect(end?.getHours()).toBe(23);
        expect(end?.getMinutes()).toBe(59);
        expect(linkExpiry("")).toBeNull();
    });

    it("reads a stored expiry back as the day it was set for", () => {
        expect(linkExpiryDay(linkExpiry("2026-03-14")!.toISOString())).toBe("2026-03-14");
        expect(linkExpiryDay(null)).toBe("");
    });

    it("sends a typed password, a removal, or neither", () => {
        expect(linkLimits({ ...EMPTY_LINK_ADVANCED, password: "pw" })).toMatchObject({
            password: "pw"
        });
        const cleared = linkLimits({ ...EMPTY_LINK_ADVANCED, clearPassword: true });
        expect(cleared).toMatchObject({ clearPassword: true });
        expect(cleared).not.toHaveProperty("password");
        const untouched = linkLimits(EMPTY_LINK_ADVANCED);
        expect(untouched).not.toHaveProperty("password");
        expect(untouched).not.toHaveProperty("clearPassword");
    });

    it("sends the cap as a number and no limits as nulls", () => {
        expect(linkLimits({ ...EMPTY_LINK_ADVANCED, maxUses: "10" })).toMatchObject({
            maxViews: 10,
            expiresAt: null
        });
        expect(linkLimits(EMPTY_LINK_ADVANCED)).toMatchObject({ maxViews: null, expiresAt: null });
    });

    it("keeps a stored window in its own time zone when the link is edited", () => {
        const stored = {
            days: 0b0111110,
            startMinute: 9 * 60,
            endMinute: 17 * 60,
            timeZone: "Pacific/Chatham"
        };
        const value = {
            ...EMPTY_LINK_ADVANCED,
            ...linkGuardFields({ ...NO_LINK_GUARDS, schedule: stored })
        };
        expect(value.timeZone).toBe("Pacific/Chatham");
        expect(linkSchedule({ ...value, password: "pw" })).toEqual(stored);
    });

    it("reads a new window on the reader's own clock", () => {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        expect(
            linkSchedule({ ...EMPTY_LINK_ADVANCED, hoursFrom: "09:00", hoursTo: "17:00" })
        ).toMatchObject({ startMinute: 540, endMinute: 1020, timeZone: zone });
    });

    it("calls half-filled hours incomplete", () => {
        expect(linkHoursIncomplete({ ...EMPTY_LINK_ADVANCED, hoursFrom: "09:00" })).toBe(true);
        expect(linkHoursIncomplete(EMPTY_LINK_ADVANCED)).toBe(false);
    });
});
