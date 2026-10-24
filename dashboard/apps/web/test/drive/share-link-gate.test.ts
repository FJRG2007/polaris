/**
 * A Drive share's link runs every rule a public link offers through the one
 * shared check: its start, its weekly hours, and whether it needs an account or
 * one of the people it names. A share written before those rules existed opens
 * exactly as it did.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

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
        expect(findUnique.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(reason, (who) => {
        viewer = who;
    });
});
