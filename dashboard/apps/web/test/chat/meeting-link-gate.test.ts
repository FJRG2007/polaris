/**
 * A meeting's guest link runs the same gates as every other public link,
 * minus the expiry and cap the call already decides: open call, address rules,
 * fraud check, then the password. Only the host may read or set its limits.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { meeting: { findUnique, update } } }));

let ip: string | undefined = "198.51.100.7";
vi.mock("@/lib/request-context", () => ({ clientIp: async () => ip }));
let flagged = false;
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: !flagged }) }));
let inRegion = true;
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => inRegion }));
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: async (value: string) => `hashed:${value}`,
    verifyLinkPassword: async (value: string, hash: string) => hash === `hashed:${value}`
}));

let cookie: string | undefined;
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) })
}));

const gate = await import("@/lib/chat/meeting-link-access");

const MEETING = "01a081bf-94a6-76c1-9907-ab70aa5f6472";
const HOST = "01a081bf-94a6-76c1-9907-ab70aa5f6473";
const HASH = "hashed:open-sesame";
const row = (overrides: Record<string, unknown> = {}) => ({
    id: MEETING,
    endedAt: null,
    linkPasswordHash: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});

describe("a meeting's guest link", () => {
    it("opens with no limits, as every existing link has", async () => {
        findUnique.mockResolvedValueOnce(row());
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: true, meetingId: MEETING });
    });

    it("answers not_found for an unknown token and an ended call alike", async () => {
        findUnique.mockResolvedValueOnce(null);
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: false, reason: "not_found" });
        findUnique.mockResolvedValueOnce(row({ endedAt: new Date() }));
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: false, reason: "not_found" });
        expect(await gate.gateMeetingLink("")).toEqual({ ok: false, reason: "not_found" });
    });

    it("refuses an address outside its list", async () => {
        ip = "203.0.113.9";
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        expect(await gate.gateMeetingLink("token")).toEqual({
            ok: false,
            reason: "ip_not_allowed"
        });
        ip = "198.51.100.7";
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: true, meetingId: MEETING });
    });

    it("refuses a visitor outside its countries", async () => {
        inRegion = false;
        findUnique.mockResolvedValueOnce(row({ allowedCountries: '["ES"]' }));
        expect(await gate.gateMeetingLink("token")).toEqual({
            ok: false,
            reason: "country_not_allowed"
        });
        inRegion = true;
    });

    it("refuses an address the fraud check flags", async () => {
        flagged = true;
        findUnique.mockResolvedValueOnce(row());
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: false, reason: "ip_flagged" });
        flagged = false;
    });

    it("asks for the password until it is solved, in its own scope", async () => {
        cookie = undefined;
        findUnique.mockResolvedValueOnce(row({ linkPasswordHash: HASH }));
        expect(await gate.gateMeetingLink("token")).toEqual({
            ok: false,
            reason: "password_required"
        });

        cookie = gate.signMeetingUnlock(MEETING, HASH);
        findUnique.mockResolvedValueOnce(row({ linkPasswordHash: HASH }));
        expect(await gate.gateMeetingLink("token")).toEqual({ ok: true, meetingId: MEETING });

        const { signUnlock } = await import("@/lib/link-guards");
        cookie = signUnlock(
            "task",
            MEETING,
            { passwordHash: HASH },
            "one-secret-for-every-signature-here"
        );
        findUnique.mockResolvedValueOnce(row({ linkPasswordHash: HASH }));
        expect(await gate.gateMeetingLink("token")).toEqual({
            ok: false,
            reason: "password_required"
        });
        cookie = undefined;
    });

    it("lets only the host set its limits, and keeps the password unless one is typed", async () => {
        findUnique.mockResolvedValueOnce({ ...row(), hostId: "somebody-else" });
        await expect(
            gate.setMeetingLinkLimits(HOST, MEETING, gate.meetingLinkLimitsSchema.parse({}))
        ).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();

        findUnique.mockResolvedValueOnce({ ...row(), hostId: HOST });
        update.mockResolvedValueOnce(row({ linkPasswordHash: HASH, allowedCountries: '["ES"]' }));
        const saved = await gate.setMeetingLinkLimits(
            HOST,
            MEETING,
            gate.meetingLinkLimitsSchema.parse({ allowedCountries: ["es"] })
        );
        expect(update.mock.calls[0][0].data).toEqual({
            allowedCidrs: "[]",
            allowedCountries: '["ES"]',
            allowedContinents: "[]",
            startsAt: null,
            allowedUsers: "[]",
            linkSchedule: ""
        });
        expect(saved).toEqual({
            hasPassword: true,
            allowedCidrs: [],
            allowedCountries: ["ES"],
            allowedContinents: [],
            guards: { startsAt: null, schedule: null, requireLogin: false, allowedUsers: [] }
        });

        findUnique.mockResolvedValueOnce({ ...row(), hostId: HOST });
        update.mockResolvedValueOnce(row({ linkPasswordHash: HASH }));
        await gate.setMeetingLinkLimits(
            HOST,
            MEETING,
            gate.meetingLinkLimitsSchema.parse({ password: "open-sesame" })
        );
        expect(update.mock.calls[1][0].data.linkPasswordHash).toBe(HASH);
    });
});
