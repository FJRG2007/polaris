/**
 * A snippet's public link runs the start, hours and account rules through the
 * one shared link check, and its owner is never turned away by them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));
const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        snippet: { findUnique },
        snippetAccessLog: { create: async () => ({}) },
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
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({
    guardedUser: async () => viewer,
    getSession: async () => (viewer ? { user: viewer } : null)
}));

const { gateSnippetRequest } = await import("@/lib/snippet-access");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "snip-1",
    ownerId: "u-owner",
    visibility: "link",
    passwordHash: null,
    maxViews: null,
    viewCount: 0,
    expiresAt: null,
    revokedAt: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    invites: [],
    ...overrides
});
const reason = async (overrides: Record<string, unknown>) => {
    findUnique.mockResolvedValueOnce(row(overrides));
    const gate = await gateSnippetRequest("token", "view");
    return gate.ok ? "ok" : gate.reason;
};

beforeEach(() => {
    viewer = null;
    findUnique.mockReset();
});

describe("a snippet's public link", () => {
    it("reads the start, hours and people columns with the snippet", async () => {
        await reason({});
        expect(findUnique.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(reason, (who) => {
        viewer = who;
    });

    it("lets its owner through a list that does not name them", async () => {
        viewer = { id: "u-owner" };
        expect(await reason({ requireLogin: true, allowedUsers: '["someone-else"]' })).toBe("ok");
    });
});
