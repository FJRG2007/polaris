/**
 * An organization's shared writing guide. Every member reads it; only
 * somebody holding settings.manage there changes it, checked on the server
 * whatever the screen offered; an unchanged guide writes nothing, and a
 * change is audited against the organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
    organization: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() }
}));
const orgs = vi.hoisted(() => ({
    listMyOrgs: vi.fn(),
    resolveOrgAccess: vi.fn(),
    requireOrgPermission: vi.fn(),
    orgCan: vi.fn()
}));
const recordAudit = vi.hoisted(() => vi.fn());
const viewer = vi.hoisted(() => ({ value: { id: "u1", isAdmin: false } as Record<string, unknown> }));
vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/orgs/org-service", () => orgs);
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/session", () => ({ requireUser: async () => viewer.value }));
vi.mock("@/lib/polar/access", () => ({ polarAccessFor: async () => ({ use: true }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
const scope = vi.hoisted(() => ({ org: "a" as string | null }));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => scope.org }));

const { orgWritingGuidesAction, saveOrgWritingGuideAction } = await import(
    "@/app/(app)/polar/settings/writing-actions"
);

const ORG = "0190a3a0-0000-7000-8000-000000000001";

beforeEach(() => {
    vi.clearAllMocks();
    viewer.value = { id: "u1", isAdmin: false };
    scope.org = "a";
});

describe("reading the guides", () => {
    it("shows none from the personal shelf", async () => {
        scope.org = null;
        expect(await orgWritingGuidesAction()).toEqual({ ok: true, value: [] });
        expect(orgs.listMyOrgs).not.toHaveBeenCalled();
    });

    it("shows only the organization being worked in, with whether it may be edited", async () => {
        orgs.listMyOrgs.mockResolvedValue([
            { id: "a", name: "Acme", restricted: false, role: "admin" },
            { id: "b", name: "Beta", restricted: false, role: "member" },
            { id: "c", name: "Closed", restricted: true, role: "member" },
            { id: "d", name: "Heir", restricted: false, role: "successor" }
        ]);
        prisma.organization.findMany.mockResolvedValue([
            { id: "a", writingGuide: "Sign as Acme." },
            { id: "b", writingGuide: "" }
        ]);
        orgs.resolveOrgAccess.mockImplementation(async (_actor, id: string) => ({ id }));
        orgs.orgCan.mockImplementation((access: { id: string }) => access.id === "a");
        const result = await orgWritingGuidesAction();
        expect(result).toEqual({
            ok: true,
            value: [{ id: "a", name: "Acme", guide: "Sign as Acme.", canEdit: true }]
        });
    });
});

describe("saving a guide", () => {
    it("is refused without settings.manage, and writes nothing", async () => {
        orgs.requireOrgPermission.mockRejectedValue(new Error("no"));
        const result = await saveOrgWritingGuideAction({ orgId: ORG, guide: "x" });
        expect(result).toEqual({ ok: false, error: "settings.writing.errors.notAllowed" });
        expect(orgs.requireOrgPermission).toHaveBeenCalledWith(
            { id: "u1", isAdmin: false },
            ORG,
            "settings.manage"
        );
        expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it("saves a change trimmed, and audits it against the organization", async () => {
        orgs.requireOrgPermission.mockResolvedValue({});
        prisma.organization.findUnique.mockResolvedValue({ writingGuide: "" });
        const result = await saveOrgWritingGuideAction({ orgId: ORG, guide: "  Sign as Acme.  " });
        expect(result).toEqual({ ok: true, value: "Sign as Acme." });
        expect(prisma.organization.update).toHaveBeenCalledWith({
            where: { id: ORG },
            data: { writingGuide: "Sign as Acme." }
        });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "org.writing-guide", orgId: ORG })
        );
    });

    it("writes nothing when the guide did not change", async () => {
        orgs.requireOrgPermission.mockResolvedValue({});
        prisma.organization.findUnique.mockResolvedValue({ writingGuide: "Same." });
        await saveOrgWritingGuideAction({ orgId: ORG, guide: "Same." });
        expect(prisma.organization.update).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("refuses a guide that is too long, or somebody viewing as another account", async () => {
        expect(await saveOrgWritingGuideAction({ orgId: ORG, guide: "x".repeat(8_001) })).toEqual({
            ok: false,
            error: "settings.writing.errors.tooLong"
        });
        viewer.value = { id: "u1", isAdmin: true, viewingAs: { id: "admin" } };
        expect(await saveOrgWritingGuideAction({ orgId: ORG, guide: "x" })).toEqual({
            ok: false,
            error: "settings.writing.errors.viewingAs"
        });
    });
});
