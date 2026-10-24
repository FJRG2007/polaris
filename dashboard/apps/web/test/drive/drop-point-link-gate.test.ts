/**
 * Both kinds of drop point - files (/r) and text (/tr) - run their start,
 * weekly hours, address and account rules through the one shared link check,
 * and read the hours column with the rest of the row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "s", POLARIS_MASTER_KEY: "k" })
}));
const fileFind = vi.fn();
const textFind = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        fileRequest: { findUnique: fileFind },
        textRequest: { findUnique: textFind },
        user: { findUnique: async () => ({ username: "ana" }) }
    }
}));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: vi.fn() }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));

const files = await import("@/lib/file-request-service");
const texts = await import("@/lib/text-request-service");

const base = (overrides: Record<string, unknown>) => ({
    id: "req-1",
    ownerId: "owner-1",
    requireLogin: false,
    allowedUsers: "[]",
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    startsAt: null,
    linkSchedule: "",
    expiresAt: null,
    revokedAt: null,
    ...overrides
});
const fileReason = async (overrides: Record<string, unknown>) => {
    fileFind.mockResolvedValueOnce(base(overrides));
    const request = await files.resolveFileRequestByToken("token");
    const gate = await files.fileRequestGate(request!, "198.51.100.7");
    return gate.ok ? "ok" : gate.reason;
};
const textReason = async (overrides: Record<string, unknown>) => {
    textFind.mockResolvedValueOnce(base(overrides));
    const request = await texts.resolveTextRequestByToken("token");
    const gate = await texts.textRequestGate(request!, "198.51.100.7");
    return gate.ok ? "ok" : gate.reason;
};

beforeEach(() => {
    viewer = null;
    fileFind.mockReset();
    textFind.mockReset();
});

describe("a file drop point's link", () => {
    it("reads the start, hours and people columns with the drop point", async () => {
        await fileReason({});
        expect(fileFind.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    it("refuses an address outside its list", async () => {
        expect(await fileReason({ allowedCidrs: '["10.0.0.0/8"]' })).toBe("ip_not_allowed");
    });

    linkGuardCases(fileReason, (who) => {
        viewer = who;
    });
});

describe("a text drop point's link", () => {
    it("reads the start, hours and people columns with the drop point", async () => {
        await textReason({});
        expect(textFind.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(textReason, (who) => {
        viewer = who;
    });
});
