/**
 * A document's public link runs the start, hours and account rules through the
 * one shared link check, and the card says why in words for any link.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({
        POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here",
        POLARIS_MASTER_KEY: "k"
    })
}));
const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        officeLink: { findUnique },
        user: { findUnique: async () => ({ username: "ana" }) }
    }
}));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "198.51.100.7" }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));

const { gateOfficeLink, officeLinkDenial } = await import("@/lib/office/link-access");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "link-1",
    documentId: "doc-1",
    role: "viewer",
    passwordHash: null,
    expiresAt: null,
    revokedAt: null,
    maxUses: null,
    useCount: 0,
    lastUsedAt: null,
    note: "",
    createdAt: new Date(),
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});
const reason = async (overrides: Record<string, unknown>) => {
    findUnique.mockResolvedValueOnce(row(overrides));
    const gate = await gateOfficeLink("token");
    return gate.ok ? "ok" : gate.reason;
};

beforeEach(() => {
    viewer = null;
    findUnique.mockReset();
});

describe("a document's public link", () => {
    it("reads the start, hours and people columns with the link", async () => {
        await reason({});
        expect(findUnique.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(reason, (who) => {
        viewer = who;
    });

    it("says outside its hours, sign in, or not invited in the shared words", async () => {
        expect(await officeLinkDenial("outside_hours")).toBe("denied.closed");
        expect(await officeLinkDenial("sign_in_required")).toBe("denied.signIn");
        expect(await officeLinkDenial("not_invited")).toBe("denied.notInvited");
    });
});
