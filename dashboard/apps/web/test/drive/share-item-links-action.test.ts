/**
 * The share dialog's list of links that already exist: the reader's own links
 * to that exact item, read with the filter in the database, revoked ones left
 * out, and nothing at all for an input that is not an item.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

function stored(id: string, revokedAt: Date | null) {
    return {
        id,
        path: "Photos/2026",
        kind: "public",
        connectionId: "c1",
        connection: { name: "NAS" },
        allowUpload: false,
        allowRename: false,
        allowDelete: false,
        allowCreateFolder: false,
        allowOverwrite: false,
        allowDownload: true,
        allowPreview: true,
        allowedCidrs: null,
        allowedCountries: null,
        allowedContinents: null,
        passwordHash: "x",
        maxDownloads: 10,
        downloadCount: 3,
        expiresAt: null,
        revokedAt,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        encryptedToken: "t"
    };
}

const mocks = vi.hoisted(() => ({ listSharesForOwner: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/domain-service", () => ({
    sharingBaseUrl: async () => "https://share.example.test"
}));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/share-service", () => ({ listSharesForOwner: mocks.listSharesForOwner }));
vi.mock("@/lib/link-guards", () => ({
    parseStringList: () => [],
    readLinkGuards: () => ({})
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ clientIp: vi.fn(), hashForLog: vi.fn() }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {},
    authorizeDrive: vi.fn(async () => undefined)
}));

const { itemLinksAction } = await import("@/app/(app)/drive/share-actions");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSharesForOwner.mockResolvedValue([stored("live", null), stored("gone", new Date())]);
});

describe("itemLinksAction", () => {
    it("asks for the reader's own links to that item and drops revoked ones", async () => {
        const result = await itemLinksAction({ connectionId: "c1", path: "/Photos//2026/" });
        expect(mocks.listSharesForOwner).toHaveBeenCalledWith("user-1", {
            connectionId: "c1",
            path: "Photos/2026"
        });
        expect(result.links.map((link) => link.id)).toEqual(["live"]);
        expect(result.links[0]).toMatchObject({
            hasPassword: true,
            maxDownloads: 10,
            downloadCount: 3,
            createdAt: "2026-10-01T00:00:00.000Z"
        });
    });

    it("answers nothing, without reading, for input that is not an item", async () => {
        expect(await itemLinksAction({ connectionId: "", path: "x" })).toEqual({ links: [] });
        expect(await itemLinksAction({ connectionId: "c1", path: "../etc" })).toEqual({
            links: []
        });
        expect(await itemLinksAction("nope")).toEqual({ links: [] });
        expect(mocks.listSharesForOwner).not.toHaveBeenCalled();
    });
});
