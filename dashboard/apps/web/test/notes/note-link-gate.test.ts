/**
 * A published note's link runs the start, hours and account rules through the
 * one shared link check.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));
const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        noteShare: { findUnique },
        user: { findUnique: async () => ({ username: "ana" }) }
    }
}));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/notes/access", () => ({}));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "198.51.100.7" }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));

const { gateNoteShareRequest } = await import("@/lib/notes/share-access");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "share-1",
    noteId: "note-1",
    includeChildren: true,
    passwordHash: null,
    maxViews: null,
    viewCount: 0,
    expiresAt: null,
    revokedAt: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});
const reason = async (overrides: Record<string, unknown>) => {
    findUnique.mockResolvedValueOnce(row(overrides));
    const gate = await gateNoteShareRequest("token");
    return gate.ok ? "ok" : gate.reason;
};

beforeEach(() => {
    viewer = null;
    findUnique.mockReset();
});

describe("a published note's link", () => {
    it("reads the start, hours and people columns with the link", async () => {
        await reason({});
        expect(findUnique.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(reason, (who) => {
        viewer = who;
    });
});
