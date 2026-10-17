/**
 * Who may touch an automation, and who may let one onto the local network:
 * the same checks the screens use to hide what the server refuses.
 */

import { describe, expect, it, vi } from "vitest";

const roles = vi.hoisted(() => ({ byOrg: {} as Record<string, string[]> }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess: async (_actor: unknown, orgId: string) =>
        roles.byOrg[orgId] ? { permissions: roles.byOrg[orgId] } : null,
    orgCan: (access: { permissions: string[] } | null, permission: string) =>
        access !== null && access.permissions.includes(permission)
}));

const runner = await import("@/lib/automations/runner");

const member = { id: "u1", isAdmin: false };
const admin = { id: "u1", isAdmin: true };

describe("shelf access", () => {
    it("gives a personal shelf to its owner only", async () => {
        expect(await runner.mayEditShelf(member, { orgId: null, userId: "u1" })).toBe(true);
        expect(await runner.mayEditShelf(member, { orgId: null, userId: "u2" })).toBe(false);
        expect(await runner.mayReadShelf(member, { orgId: null, userId: "u2" })).toBe(false);
    });

    it("lets org members read and only org admins edit", async () => {
        roles.byOrg = { o1: ["org.read"], o2: ["org.read", runner.ORG_EDIT_PERMISSION] };
        expect(await runner.mayReadShelf(member, { orgId: "o1", userId: null })).toBe(true);
        expect(await runner.mayEditShelf(member, { orgId: "o1", userId: null })).toBe(false);
        expect(await runner.mayEditShelf(member, { orgId: "o2", userId: null })).toBe(true);
        expect(await runner.mayReadShelf(member, { orgId: "o3", userId: null })).toBe(false);
    });
});

describe("the local network switch", () => {
    it("is for an org admin on an org automation, not every editor", async () => {
        roles.byOrg = { o1: ["org.read"], o2: ["org.read", runner.ORG_EDIT_PERMISSION], o3: ["*"] };
        expect(await runner.mayAllowLocalNetwork(member, { orgId: "o1", userId: null })).toBe(
            false
        );
        expect(await runner.mayAllowLocalNetwork(member, { orgId: "o2", userId: null })).toBe(
            false
        );
        expect(await runner.mayAllowLocalNetwork(member, { orgId: "o3", userId: null })).toBe(true);
        expect(await runner.mayAllowLocalNetwork(member, { orgId: "o4", userId: null })).toBe(
            false
        );
    });

    it("is for an instance administrator on their own personal automation only", async () => {
        expect(await runner.mayAllowLocalNetwork(member, { orgId: null, userId: "u1" })).toBe(
            false
        );
        expect(await runner.mayAllowLocalNetwork(admin, { orgId: null, userId: "u1" })).toBe(true);
        expect(await runner.mayAllowLocalNetwork(admin, { orgId: null, userId: "u2" })).toBe(false);
    });
});
