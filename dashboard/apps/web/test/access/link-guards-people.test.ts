/**
 * The start, weekly window and account rules every public link can carry, and
 * the order `checkLink` asks them in. The viewer is passed in, so nothing here
 * reads a session.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/geo-service", () => ({
    geoAllowedForIp: vi.fn(async () => true)
}));

const {
    checkLink,
    linkPeopleDenial,
    linkScheduleOpen,
    linkViewerAllowed,
    parseLinkSchedule,
    readLinkGuards,
    storedPeopleRules
} = await import("@/lib/link-guards");

const OPEN = { revokedAt: null, expiresAt: null, maxUses: null, useCount: 0 };
const ANY = { allowedCidrs: "[]", allowedCountries: "[]", allowedContinents: "[]" };
const nobody = async () => null;
const alice = async () => ({ id: "u-1", email: "alice@example.test", username: "alice" });

// 2026-03-02 is a Monday. Bit 1 is Monday in the presence-schedule mask.
const MONDAY = 0b0000010;
const nineToFive = (timeZone: string) =>
    JSON.stringify({ days: MONDAY, startMinute: 9 * 60, endMinute: 17 * 60, timeZone });

describe("parseLinkSchedule", () => {
    it("reads empty and corrupt as no window", () => {
        expect(parseLinkSchedule("")).toBeNull();
        expect(parseLinkSchedule(null)).toBeNull();
        expect(parseLinkSchedule("{not json")).toBeNull();
        expect(parseLinkSchedule(JSON.stringify({ days: 0, timeZone: "UTC" }))).toBeNull();
        expect(
            parseLinkSchedule(
                JSON.stringify({ days: 1, startMinute: 60, endMinute: null, timeZone: "UTC" })
            )
        ).toBeNull();
        expect(
            parseLinkSchedule(
                JSON.stringify({
                    days: 1,
                    startMinute: null,
                    endMinute: null,
                    timeZone: "Mars/Base"
                })
            )
        ).toBeNull();
    });

    it("reads a valid window back", () => {
        expect(parseLinkSchedule(nineToFive("UTC"))).toEqual({
            days: MONDAY,
            startMinute: 540,
            endMinute: 1020,
            timeZone: "UTC"
        });
    });
});

describe("linkScheduleOpen", () => {
    it("is always open without a window", () => {
        expect(linkScheduleOpen(null, new Date("2026-03-01T03:00:00Z"))).toBe(true);
    });

    it("opens inside the hours and shuts at the end, end exclusive", () => {
        const s = parseLinkSchedule(nineToFive("UTC"));
        expect(linkScheduleOpen(s, new Date("2026-03-02T08:59:00Z"))).toBe(false);
        expect(linkScheduleOpen(s, new Date("2026-03-02T09:00:00Z"))).toBe(true);
        expect(linkScheduleOpen(s, new Date("2026-03-02T16:59:00Z"))).toBe(true);
        expect(linkScheduleOpen(s, new Date("2026-03-02T17:00:00Z"))).toBe(false);
        // Right hour, wrong day (Tuesday).
        expect(linkScheduleOpen(s, new Date("2026-03-03T10:00:00Z"))).toBe(false);
    });

    it("reads the hours on the link's own clock, across a day boundary", () => {
        // 09:00 Monday in Tokyo is 00:00 Monday UTC; 23:30 Sunday UTC is 08:30 Monday there.
        const tokyo = parseLinkSchedule(nineToFive("Asia/Tokyo"));
        expect(linkScheduleOpen(tokyo, new Date("2026-03-02T00:30:00Z"))).toBe(true);
        expect(linkScheduleOpen(tokyo, new Date("2026-03-01T23:30:00Z"))).toBe(false);
        // Monday 10:00 UTC is 19:00 in Tokyo: outside.
        expect(linkScheduleOpen(tokyo, new Date("2026-03-02T10:00:00Z"))).toBe(false);
    });

    it("keeps a window that crosses midnight open after it", () => {
        const night = parseLinkSchedule(
            JSON.stringify({
                days: MONDAY,
                startMinute: 22 * 60,
                endMinute: 6 * 60,
                timeZone: "UTC"
            })
        );
        expect(linkScheduleOpen(night, new Date("2026-03-02T23:00:00Z"))).toBe(true);
        expect(linkScheduleOpen(night, new Date("2026-03-03T05:00:00Z"))).toBe(true);
        expect(linkScheduleOpen(night, new Date("2026-03-03T07:00:00Z"))).toBe(false);
    });

    it("opens a whole named day when no hours are given", () => {
        const days = parseLinkSchedule(
            JSON.stringify({ days: MONDAY, startMinute: null, endMinute: null, timeZone: "UTC" })
        );
        expect(linkScheduleOpen(days, new Date("2026-03-02T00:00:00Z"))).toBe(true);
        expect(linkScheduleOpen(days, new Date("2026-03-02T23:58:00Z"))).toBe(true);
        expect(linkScheduleOpen(days, new Date("2026-03-03T00:00:00Z"))).toBe(false);
    });
});

describe("linkViewerAllowed", () => {
    const viewer = { id: "U-1", email: "Alice@Example.test", username: "alice" };

    it("lets anyone through an empty list", () => {
        expect(linkViewerAllowed(viewer, [])).toBe(true);
    });

    it("matches by username, address or id, however it was typed", () => {
        expect(linkViewerAllowed(viewer, ["@ALICE"])).toBe(true);
        expect(linkViewerAllowed(viewer, [" alice@example.test "])).toBe(true);
        expect(linkViewerAllowed(viewer, ["u-1"])).toBe(true);
    });

    it("refuses somebody the list does not name", () => {
        expect(linkViewerAllowed(viewer, ["bob", "bob@example.test"])).toBe(false);
        expect(linkViewerAllowed({ id: "u-2", email: null, username: null }, ["alice"])).toBe(
            false
        );
    });
});

describe("linkPeopleDenial", () => {
    it("never asks who is there when no rule needs it", async () => {
        const viewer = vi.fn(nobody);
        expect(
            await linkPeopleDenial({ requireLogin: false, allowedUsers: "[]" }, viewer)
        ).toBeNull();
        expect(await linkPeopleDenial({}, viewer)).toBeNull();
        expect(viewer).not.toHaveBeenCalled();
    });

    it("asks a signed-out visitor to sign in", async () => {
        expect(await linkPeopleDenial({ requireLogin: true }, nobody)).toBe("sign_in_required");
    });

    it("treats a list of people as needing sign-in even with the switch off", async () => {
        expect(
            await linkPeopleDenial({ requireLogin: false, allowedUsers: '["alice"]' }, nobody)
        ).toBe("sign_in_required");
    });

    it("lets any account in when only sign-in is asked", async () => {
        expect(await linkPeopleDenial({ requireLogin: true }, alice)).toBeNull();
    });

    it("refuses an account the list does not name", async () => {
        expect(await linkPeopleDenial({ allowedUsers: '["bob"]' }, alice)).toBe("not_invited");
        expect(await linkPeopleDenial({ allowedUsers: '["alice"]' }, alice)).toBeNull();
    });

    it("reads a corrupt list as no list", async () => {
        expect(await linkPeopleDenial({ allowedUsers: "{oops" }, nobody)).toBeNull();
    });
});

describe("checkLink order", () => {
    const now = new Date("2026-03-02T12:00:00Z");

    it("passes a link with no rules, as every link made before them", async () => {
        expect(await checkLink({ limits: OPEN, rules: ANY }, "203.0.113.5", now, nobody)).toEqual({
            ok: true
        });
        expect(
            await checkLink(
                { limits: OPEN, rules: ANY, guards: storedPeopleRules({}) },
                "203.0.113.5",
                now,
                nobody
            )
        ).toEqual({ ok: true });
    });

    it("says not started before anything else after revocation", async () => {
        const verdict = await checkLink(
            {
                limits: { ...OPEN, startsAt: new Date("2026-04-01T00:00:00Z") },
                rules: ANY,
                guards: { requireLogin: true, linkSchedule: nineToFive("UTC") }
            },
            undefined,
            now,
            nobody
        );
        expect(verdict).toEqual({ ok: false, reason: "scheduled" });
    });

    it("says outside its hours before the address or the account", async () => {
        const verdict = await checkLink(
            {
                limits: OPEN,
                rules: { ...ANY, allowedCidrs: '["10.0.0.0/8"]' },
                guards: { requireLogin: true, linkSchedule: nineToFive("UTC") }
            },
            "203.0.113.5",
            new Date("2026-03-02T20:00:00Z"),
            nobody
        );
        expect(verdict).toEqual({ ok: false, reason: "outside_hours" });
    });

    it("refuses the address before asking anybody to sign in", async () => {
        const viewer = vi.fn(nobody);
        const verdict = await checkLink(
            {
                limits: OPEN,
                rules: { ...ANY, allowedCidrs: '["10.0.0.0/8"]' },
                guards: { requireLogin: true }
            },
            "203.0.113.5",
            now,
            viewer
        );
        expect(verdict).toEqual({ ok: false, reason: "ip_not_allowed" });
        expect(viewer).not.toHaveBeenCalled();
    });

    it("ends on the account rules", async () => {
        const guards = {
            requireLogin: true,
            allowedUsers: '["bob"]',
            linkSchedule: nineToFive("UTC")
        };
        expect(
            await checkLink({ limits: OPEN, rules: ANY, guards }, "203.0.113.5", now, nobody)
        ).toEqual({
            ok: false,
            reason: "sign_in_required"
        });
        expect(
            await checkLink({ limits: OPEN, rules: ANY, guards }, "203.0.113.5", now, alice)
        ).toEqual({
            ok: false,
            reason: "not_invited"
        });
        expect(
            await checkLink(
                { limits: OPEN, rules: ANY, guards: { ...guards, allowedUsers: '["alice"]' } },
                "203.0.113.5",
                now,
                alice
            )
        ).toEqual({ ok: true });
    });
});

describe("stored and read back", () => {
    it("round-trips the columns a dialog shows", () => {
        const schedule = { days: MONDAY, startMinute: 540, endMinute: 1020, timeZone: "UTC" };
        const stored = storedPeopleRules({ requireLogin: true, allowedUsers: ["alice"], schedule });
        expect(stored).toEqual({
            requireLogin: true,
            allowedUsers: '["alice"]',
            linkSchedule: JSON.stringify(schedule)
        });
        expect(readLinkGuards({ ...stored, startsAt: new Date("2026-04-01T00:00:00Z") })).toEqual({
            startsAt: "2026-04-01T00:00:00.000Z",
            schedule,
            requireLogin: true,
            allowedUsers: ["alice"]
        });
        expect(storedPeopleRules({}).linkSchedule).toBe("");
    });
});
