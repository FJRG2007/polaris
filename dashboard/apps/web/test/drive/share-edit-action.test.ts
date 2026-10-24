/**
 * Editing a Drive share link from the shared-links list goes through the same
 * schema every link's limits do: the start, weekly hours, sign-in, named people,
 * address and region rules all reach the service, a malformed one is refused
 * before anything is written, and a field the edit does not send is left alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findOwnedShareTarget: vi.fn(async () => ({ connectionId: "c1", path: "/docs" })),
    updateShare: vi.fn(async () => undefined)
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/domain-service", () => ({
    sharingBaseUrl: async () => "https://share.example.test"
}));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/share-service", () => ({
    findOwnedShareTarget: mocks.findOwnedShareTarget,
    updateShare: mocks.updateShare
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ clientIp: vi.fn(), hashForLog: vi.fn() }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {},
    authorizeDrive: vi.fn(async () => undefined)
}));

const { updateShareAction } = await import("@/app/(app)/drive/share-actions");

const SHARE = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = { days: 62, startMinute: 540, endMinute: 1080, timeZone: "Europe/Madrid" };

beforeEach(() => {
    vi.clearAllMocks();
});

describe("updateShareAction schema", () => {
    it("hands every guardrail the create dialog offers to the service", async () => {
        const result = await updateShareAction(SHARE, {
            password: "hunter22",
            maxDownloads: 5,
            expiresAt: "2026-12-31T23:59:59.000Z",
            allowedCidrs: [" 203.0.113.4 ", "10.0.0.0/24"],
            allowedCountries: ["es"],
            allowedContinents: ["eu"],
            startsAt: "2026-11-01T00:00:00.000Z",
            schedule: SCHEDULE,
            requireLogin: true,
            allowedUsers: ["@Ana", "bea@example.test", "ana"],
            allowDownload: false
        });
        expect(result).toEqual({});
        expect(mocks.updateShare).toHaveBeenCalledWith(
            "user-1",
            SHARE,
            expect.objectContaining({
                password: "hunter22",
                maxDownloads: 5,
                expiresAt: new Date("2026-12-31T23:59:59.000Z"),
                allowedCidrs: ["203.0.113.4", "10.0.0.0/24"],
                allowedCountries: ["ES"],
                allowedContinents: ["EU"],
                startsAt: new Date("2026-11-01T00:00:00.000Z"),
                schedule: SCHEDULE,
                requireLogin: true,
                allowedUsers: ["ana", "bea@example.test"],
                allowDownload: false
            })
        );
    });

    it("leaves out what the edit does not send, so it keeps what is stored", async () => {
        await updateShareAction(SHARE, { allowDelete: false });
        const sent = (mocks.updateShare.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
        expect(sent.allowDelete).toBe(false);
        for (const key of [
            "password",
            "maxDownloads",
            "expiresAt",
            "allowedCidrs",
            "allowedCountries",
            "allowedContinents",
            "startsAt",
            "schedule",
            "requireLogin",
            "allowedUsers"
        ]) {
            expect(sent[key], key).toBeUndefined();
        }
    });

    it("clears the password, cap, expiry, start and hours when asked", async () => {
        await updateShareAction(SHARE, {
            clearPassword: true,
            maxDownloads: null,
            expiresAt: null,
            startsAt: null,
            schedule: null
        });
        expect(mocks.updateShare).toHaveBeenCalledWith(
            "user-1",
            SHARE,
            expect.objectContaining({
                password: null,
                maxDownloads: null,
                expiresAt: null,
                startsAt: null,
                schedule: null
            })
        );
    });

    it.each([
        ["an address that is not one", { allowedCidrs: ["not-an-ip"] }],
        ["a country that is not a code", { allowedCountries: ["Spain"] }],
        ["hours with a start and no end", { schedule: { ...SCHEDULE, endMinute: null } }],
        ["a time zone that does not exist", { schedule: { ...SCHEDULE, timeZone: "Mars/Base" } }],
        ["a cap that is not a whole number", { maxDownloads: 1.5 }],
        ["a power that is not a switch", { allowUpload: "yes" }],
        ["no edit at all", null]
    ])("refuses %s and writes nothing", async (_label, edit) => {
        const result = await updateShareAction(SHARE, edit);
        expect(result.error).toBeTruthy();
        expect(mocks.updateShare).not.toHaveBeenCalled();
        expect(mocks.findOwnedShareTarget).not.toHaveBeenCalled();
    });
});
