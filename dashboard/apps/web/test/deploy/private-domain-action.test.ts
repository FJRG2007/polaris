/**
 * Making an address private, at the action boundary: nobody without `domains.manage`
 * on the project changes who may open it, a malformed audience never reaches the
 * database, and a change that does land republishes the edge and is audited.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DOMAIN = "0192f1e2-7b5c-7d3e-8f00-00000000000d";

// The actions module reaches the auth and database clients at import time; neither is
// used here, they only have to construct.
vi.hoisted(() => {
    process.env.POLARIS_DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
    process.env.POLARIS_AUTH_SECRET ??= "test-secret-for-the-action-0123456789";
    process.env.POLARIS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

const mocks = vi.hoisted(() => ({
    requirePermission: vi.fn(async () => ({ id: "member-1", isAdmin: false })),
    requireDomainAccess: vi.fn(async () => ({ ownerId: "owner-1", environmentId: "env-1" })),
    setApplicationDomainPrivate: vi.fn(async () => ({ published: true })),
    recordDeployAudit: vi.fn(async () => undefined)
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/lib/deploy-project-access", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    requireDomainAccess: mocks.requireDomainAccess
}));
vi.mock("@/lib/deploy-service", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    setApplicationDomainPrivate: mocks.setApplicationDomainPrivate
}));
vi.mock("@/lib/deploy-audit", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    recordDeployAudit: mocks.recordDeployAudit
}));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return {
        getTranslations: async (namespace: "deployServer") => translatorFor("en-US", namespace)
    };
});

const { setDomainPrivateAction } = await import("@/app/(app)/apps/deploy/actions");

beforeEach(() => {
    vi.clearAllMocks();
});

describe("making an address private", () => {
    it("asks for domains.manage on the address's project and saves the audience", async () => {
        const access = { members: true, allow: [{ ref: "group:eng" }], deny: [] };
        expect(await setDomainPrivateAction({ domainId: DOMAIN, access })).toEqual({});
        expect(mocks.requirePermission).toHaveBeenCalledWith("deploy.manage");
        expect(mocks.requireDomainAccess).toHaveBeenCalledWith(
            DOMAIN,
            "member-1",
            "domains.manage"
        );
        expect(mocks.setApplicationDomainPrivate).toHaveBeenCalledWith(DOMAIN, "owner-1", access);
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.domain.private.on", targetId: DOMAIN })
        );
    });

    it("changes nothing for somebody who cannot manage the project's domains", async () => {
        mocks.requireDomainAccess.mockRejectedValueOnce(new Error("Domain not found"));
        const result = await setDomainPrivateAction({ domainId: DOMAIN, access: null });
        expect(result.error).toBe("Domain not found");
        expect(mocks.setApplicationDomainPrivate).not.toHaveBeenCalled();
        expect(mocks.recordDeployAudit).not.toHaveBeenCalled();
    });

    it("still audits a saved setting the edge did not take yet, and says so", async () => {
        mocks.setApplicationDomainPrivate.mockResolvedValueOnce({ published: false });
        const result = await setDomainPrivateAction({ domainId: DOMAIN, access: null });
        expect(result).toEqual({ unpublished: true });
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.domain.private.off", targetId: DOMAIN })
        );
    });

    it("refuses an audience nobody could match before asking anything else", async () => {
        const result = await setDomainPrivateAction({
            domainId: DOMAIN,
            access: { members: false, allow: [], deny: [] }
        });
        expect(result.error).toBeDefined();
        expect(mocks.requireDomainAccess).not.toHaveBeenCalled();
        expect(mocks.setApplicationDomainPrivate).not.toHaveBeenCalled();
    });
});
