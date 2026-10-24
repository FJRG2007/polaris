/**
 * `updateShare` writes each rule an edit names into its own column, in the
 * shape the public gate reads back, and touches nothing the edit leaves out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
vi.mock("@polaris/db", () => ({ prisma: { share: { updateMany } } }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/link-visitor", () => ({ linkVisitorId: async () => null, linkVisitorSelect: {} }));
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: async (value: string) => `hash:${value}`,
    verifyLinkPassword: vi.fn()
}));

const { updateShare } = await import("@/lib/share-service");

const SCHEDULE = { days: 62, startMinute: 540, endMinute: 1080, timeZone: "Europe/Madrid" };
const START = new Date("2026-11-01T00:00:00Z");
const END = new Date("2026-12-31T00:00:00Z");

beforeEach(() => {
    updateMany.mockClear();
});

describe("updateShare", () => {
    it.each([
        ["a new password, as a hash", { password: "pw" }, { passwordHash: "hash:pw" }],
        ["no password", { password: null }, { passwordHash: null }],
        ["a download cap", { maxDownloads: 4 }, { maxDownloads: 4 }],
        ["an expiry", { expiresAt: END }, { expiresAt: END }],
        ["addresses", { allowedCidrs: ["10.0.0.0/24"] }, { allowedCidrs: '["10.0.0.0/24"]' }],
        ["countries", { allowedCountries: ["ES"] }, { allowedCountries: '["ES"]' }],
        ["continents", { allowedContinents: ["EU"] }, { allowedContinents: '["EU"]' }],
        ["a start", { startsAt: START }, { startsAt: START }],
        ["no start", { startsAt: null }, { startsAt: null }],
        ["weekly hours", { schedule: SCHEDULE }, { linkSchedule: JSON.stringify(SCHEDULE) }],
        ["any time", { schedule: null }, { linkSchedule: "" }],
        ["sign-in", { requireLogin: true }, { requireLogin: true }],
        [
            "named people",
            { allowedUsers: ["ana", "bea@example.test"] },
            { allowedUsers: '["ana","bea@example.test"]' }
        ],
        ["a power", { allowUpload: true }, { allowUpload: true }]
    ])("stores %s in its own column and nothing else", async (_label, input, data) => {
        await updateShare("owner-1", "share-1", input);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "share-1", ownerId: "owner-1" },
            data
        });
    });
});
