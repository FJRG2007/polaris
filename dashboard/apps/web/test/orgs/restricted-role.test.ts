/**
 * A restricted member holds nothing that was not granted to them.
 *
 * Every other role carries `org.read` whether its editor granted it or not, and
 * `org.read` is what opens the roster, the organization's shelf and its internal
 * work. The restricted role is the one that does not - so what is pinned here is
 * that it resolves without it, and that "every organization whose roster this
 * person reads" leaves it out, since that one answer is what a dozen screens ask.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    role: { name: "Restricted", permissions: "[]", restricted: true } as {
        name: string;
        permissions: string;
        restricted: boolean;
    } | null,
    memberWhere: null as unknown
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: {
            findUnique: async () => ({ ownerId: "owner-1", members: [{ role: "restricted" }] }),
            findMany: async () => []
        },
        orgRole: { findUnique: async () => state.role },
        organizationMember: {
            findMany: async ({ where }: { where: unknown }) => {
                state.memberWhere = where;
                return [];
            }
        }
    }
}));

vi.mock("@/lib/successor-service", () => ({ isOrgSuccessor: async () => false }));
vi.mock("@/lib/privacy-service", () => ({ contactLines: async () => new Map() }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => [] }));

const { resolveOrgAccess, memberOrgIds, orgCan, readsOrgWhere } = await import(
    "@/lib/orgs/org-service"
);
const core = await import("@polaris/core");

beforeEach(() => {
    state.role = { name: "Restricted", permissions: "[]", restricted: true };
    state.memberWhere = null;
});

describe("the restricted role", () => {
    it("is seeded, holds nothing, and says so", () => {
        const seeded = core.ORG_SYSTEM_ROLES[core.RESTRICTED_ORG_ROLE];
        expect(seeded?.permissions).toEqual([]);
        expect(seeded?.restricted).toBe(true);
        expect(core.ORG_SYSTEM_ROLE_SLUGS).toContain(core.RESTRICTED_ORG_ROLE);
    });

    it("resolves without the implicit org.read every other role gets", async () => {
        const access = await resolveOrgAccess({ id: "someone", isAdmin: false }, "org-1");
        expect(access?.role).toBe("restricted");
        expect(orgCan(access, "org.read")).toBe(false);
    });

    it("keeps what was explicitly granted to it, and still not org.read", async () => {
        state.role = {
            name: "Restricted",
            permissions: '["teams.manage","org.read"]',
            restricted: true
        };
        const access = await resolveOrgAccess({ id: "someone", isAdmin: false }, "org-1");
        expect(orgCan(access, "teams.manage")).toBe(true);
        expect(orgCan(access, "org.read")).toBe(false);
    });

    it("leaves every other role reading the organization, as before", async () => {
        state.role = { name: "Member", permissions: "[]", restricted: false };
        const access = await resolveOrgAccess({ id: "someone", isAdmin: false }, "org-1");
        expect(orgCan(access, "org.read")).toBe(true);
    });

    it("drops out of every organization whose roster somebody reads", async () => {
        await memberOrgIds("someone");
        expect(state.memberWhere).toEqual({ userId: "someone", restricted: false });
        expect(readsOrgWhere("someone")).toEqual({
            OR: [
                { ownerId: "someone" },
                { members: { some: { userId: "someone", restricted: false } } }
            ]
        });
    });
});
