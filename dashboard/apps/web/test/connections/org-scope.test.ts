/**
 * Who manages an organization's connections: one permission, asked once, so
 * the organization's hub and the actions behind it give the same answer.
 */

import { describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => new Map<string, string[]>());

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/orgs/org-service", () => ({
    orgIdsWhere: async () => [],
    resolveOrgAccess: async (_actor: unknown, orgId: string) => {
        const permissions = access.get(orgId);
        return permissions ? { permissions } : null;
    }
}));

const { managesOrgConnections, ORG_CONNECTIONS_PERMISSION } = await import(
    "../../src/lib/connections/org-scope"
);

const actor = { id: "user-1", isAdmin: false };

describe("managing an organization's connections", () => {
    it("is whoever may manage the organization's settings", async () => {
        access.set("org-a", [ORG_CONNECTIONS_PERMISSION]);
        await expect(managesOrgConnections(actor, "org-a")).resolves.toBe(true);
    });

    it("is refused to a member without that permission, and to a stranger", async () => {
        access.set("org-b", ["servers.view"]);
        await expect(managesOrgConnections(actor, "org-b")).resolves.toBe(false);
        await expect(managesOrgConnections(actor, "org-c")).resolves.toBe(false);
    });
});
