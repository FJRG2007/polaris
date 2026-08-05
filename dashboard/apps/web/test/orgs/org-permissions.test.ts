/**
 * What one account may do inside one organization.
 *
 * Every write in the subject goes through this, so the cases pinned here are the
 * ones where being wrong is silent:
 *
 *  - the owner holds everything and is never a member row, which is what makes
 *    "remove everybody" a survivable mistake;
 *  - a membership naming a role no row answers for falls back to what that slug
 *    has always meant - never to nothing, which would lock a whole roster out of
 *    a place they belong, and never to everything;
 *  - seeing the organization comes with every role, because one that could not
 *    would be somebody who belongs here and is turned away at every door;
 *  - and grants that cannot be read grant nothing, so a corrupted column is not
 *    an escalation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const orgFindUnique = vi.fn();
const roleFindUnique = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: orgFindUnique, findMany: vi.fn() },
        orgRole: { findUnique: roleFindUnique, findMany: vi.fn(), createMany: vi.fn() },
        organizationMember: { findMany: vi.fn() }
    }
}));

const { orgCan, resolveOrgAccess } = await import("@/lib/orgs/org-service");

const ACTOR = { id: "user-1", isAdmin: false };

/** An organization owned by somebody else, with this actor holding `role`. */
function membership(role: string | null): void {
    orgFindUnique.mockResolvedValue({ ownerId: "somebody-else", members: role === null ? [] : [{ role }] });
}

describe("resolveOrgAccess", () => {
    beforeEach(() => {
        orgFindUnique.mockReset();
        roleFindUnique.mockReset();
        roleFindUnique.mockResolvedValue(null);
    });

    it("answers nothing for an organization that does not exist", async () => {
        orgFindUnique.mockResolvedValue(null);
        expect(await resolveOrgAccess(ACTOR, "org-1")).toBeNull();
    });

    it("answers nothing for an account with no part in it", async () => {
        membership(null);
        expect(await resolveOrgAccess(ACTOR, "org-1")).toBeNull();
    });

    it("gives the owner everything without reading a role row", async () => {
        orgFindUnique.mockResolvedValue({ ownerId: ACTOR.id, members: [] });
        const access = await resolveOrgAccess(ACTOR, "org-1");

        expect(access?.isOwner).toBe(true);
        expect(access?.roleName).toBe("Owner");
        expect(orgCan(access, "settings.manage")).toBe(true);
        expect(orgCan(access, "roles.manage")).toBe(true);
        expect(roleFindUnique).not.toHaveBeenCalled();
    });

    it("treats an instance administrator as the owner, so whoever runs the box is never locked out", async () => {
        membership(null);
        const access = await resolveOrgAccess({ id: "admin-1", isAdmin: true }, "org-1");

        expect(access?.isOwner).toBe(true);
        expect(orgCan(access, "people.manage")).toBe(true);
    });

    it("reads the grants off the organization's own role", async () => {
        membership("ops");
        roleFindUnique.mockResolvedValue({ name: "Operations", permissions: JSON.stringify(["deploy.manage"]) });
        const access = await resolveOrgAccess(ACTOR, "org-1");

        expect(access?.role).toBe("ops");
        expect(access?.roleName).toBe("Operations");
        expect(orgCan(access, "deploy.manage")).toBe(true);
        expect(orgCan(access, "people.manage")).toBe(false);
    });

    it("gives every role the right to see the organization", async () => {
        membership("contractor");
        roleFindUnique.mockResolvedValue({ name: "Contractor", permissions: "[]" });

        expect(orgCan(await resolveOrgAccess(ACTOR, "org-1"), "org.read")).toBe(true);
    });

    it("falls back to what a seeded slug has always meant when its row is gone", async () => {
        membership("admin");
        roleFindUnique.mockResolvedValue(null);
        const access = await resolveOrgAccess(ACTOR, "org-1");

        expect(access?.roleName).toBe("Admin");
        expect(orgCan(access, "roles.manage")).toBe(true);
    });

    it("grants nothing beyond looking when a role's stored grants cannot be read", async () => {
        membership("ops");
        roleFindUnique.mockResolvedValue({ name: "Operations", permissions: "not json" });
        const access = await resolveOrgAccess(ACTOR, "org-1");

        expect(orgCan(access, "org.read")).toBe(true);
        expect(orgCan(access, "deploy.manage")).toBe(false);
        expect(orgCan(access, "settings.manage")).toBe(false);
    });

    it("gives a role holding the wildcard everything, including what a later version adds", async () => {
        membership("admin");
        roleFindUnique.mockResolvedValue({ name: "Admin", permissions: JSON.stringify(["*"]) });
        const access = await resolveOrgAccess(ACTOR, "org-1");

        // Unrestricted, and still not the owner: handing the organization on and
        // deleting it are never permissions.
        expect(access?.isOwner).toBe(false);
        expect(orgCan(access, "domains.manage")).toBe(true);
        expect(orgCan(access, "activity.read")).toBe(true);
    });
});
