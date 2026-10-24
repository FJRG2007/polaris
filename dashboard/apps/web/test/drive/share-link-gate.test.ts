/**
 * A Drive share's link runs every rule a public link offers through the one
 * shared check: its start, its weekly hours, and whether it needs an account or
 * one of the people it names. A share written before those rules existed opens
 * exactly as it did.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));

const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        share: { findUnique },
        shareAccessLog: { create: async () => ({}) },
        user: { findUnique: async () => ({ username: "ana" }) }
    }
}));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/link-visitor", () => ({ linkVisitorId: async () => null, linkVisitorSelect: {} }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "198.51.100.7",
    clientUserAgent: async () => "test",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));

const { gateShareRequest } = await import("@/lib/share-access");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "share-1",
    connectionId: "c1",
    path: "/",
    kind: "public",
    passwordHash: null,
    maxDownloads: null,
    downloadCount: 0,
    expiresAt: null,
    revokedAt: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});
const reason = async (overrides: Record<string, unknown>) => {
    findUnique.mockResolvedValueOnce(row(overrides));
    const gate = await gateShareRequest("token", "list");
    return gate.ok ? "ok" : gate.reason;
};

beforeEach(() => {
    viewer = null;
    findUnique.mockReset();
});

describe("a Drive share's link", () => {
    it("reads the start, hours and people columns with the share", async () => {
        findUnique.mockResolvedValueOnce(row());
        await gateShareRequest("token", "list");
        expect(findUnique.mock.calls[0]![0].select).toMatchObject({
            startsAt: true,
            requireLogin: true,
            allowedUsers: true,
            linkSchedule: true
        });
    });

    it("opens as before when it has none of them", async () => {
        expect(await reason({})).toBe("ok");
    });

    it("is not open before its start", async () => {
        expect(await reason({ startsAt: new Date(Date.now() + 86_400_000) })).toBe("scheduled");
    });

    it("is closed outside its weekly hours", async () => {
        // Open on no day but the one that is not today, in UTC.
        const today = new Date().getUTCDay();
        const other = 1 << ((today + 3) % 7);
        const schedule = JSON.stringify({
            days: other,
            startMinute: null,
            endMinute: null,
            timeZone: "UTC"
        });
        expect(await reason({ linkSchedule: schedule })).toBe("outside_hours");
    });

    it("asks for an account, then opens only for the people it names", async () => {
        expect(await reason({ requireLogin: true })).toBe("sign_in_required");
        viewer = { id: "u-bea" };
        expect(await reason({ requireLogin: true })).toBe("ok");
        expect(await reason({ requireLogin: true, allowedUsers: '["someone-else"]' })).toBe(
            "not_invited"
        );
        expect(await reason({ requireLogin: true, allowedUsers: '["ana"]' })).toBe("ok");
    });
});
