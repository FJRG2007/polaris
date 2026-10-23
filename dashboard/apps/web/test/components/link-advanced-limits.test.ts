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
    linkLimits
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
});
