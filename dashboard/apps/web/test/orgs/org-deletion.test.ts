/**
 * Who may end an organization.
 *
 * Three names and no fourth: the owner, the successor the owner named on their
 * own account, and an instance administrator. The tests that matter are the
 * refusals - somebody who runs the organization in every other respect still
 * cannot delete it, and a successor of the wrong person is nobody here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const orgFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const successorFindUnique = vi.fn(async (_args: unknown) => null as unknown);

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: orgFindUnique },
        accountSuccessor: { findUnique: successorFindUnique },
        orgRole: { findUnique: vi.fn(async () => null) }
    }
}));

const { canDeleteOrg, requireOrgDeletion } = await import("../../src/lib/orgs/org-service");

const OWNER = "owner-1";
const ORG = "org-1";

/** The organization exists and belongs to OWNER. */
function ownedByOwner() {
    orgFindUnique.mockResolvedValue({ ownerId: OWNER });
}

/** Whoever `holder` named, as the successor table answers it. */
function successorOf(holder: string, successorId: string) {
    successorFindUnique.mockImplementation(async (args: unknown) => {
        const where = (args as { where: { userId: string } }).where;
        return where.userId === holder ? { successorId } : null;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    orgFindUnique.mockResolvedValue(null);
    successorFindUnique.mockResolvedValue(null);
});

describe("canDeleteOrg", () => {
    it("lets the owner delete it", async () => {
        ownedByOwner();
        expect(await canDeleteOrg({ id: OWNER, isAdmin: false }, ORG)).toBe(true);
    });

    it("lets an instance administrator delete it", async () => {
        ownedByOwner();
        expect(await canDeleteOrg({ id: "someone-else", isAdmin: true }, ORG)).toBe(true);
    });

    it("lets the successor the owner named delete it", async () => {
        ownedByOwner();
        successorOf(OWNER, "heir-1");
        expect(await canDeleteOrg({ id: "heir-1", isAdmin: false }, ORG)).toBe(true);
    });

    it("refuses somebody who is only on the roster", async () => {
        ownedByOwner();
        expect(await canDeleteOrg({ id: "member-1", isAdmin: false }, ORG)).toBe(false);
    });

    it("refuses a successor of somebody else", async () => {
        ownedByOwner();
        successorOf("a-different-person", "heir-1");
        expect(await canDeleteOrg({ id: "heir-1", isAdmin: false }, ORG)).toBe(false);
    });

    it("refuses when the organization is already gone", async () => {
        orgFindUnique.mockResolvedValue(null);
        expect(await canDeleteOrg({ id: OWNER, isAdmin: true }, ORG)).toBe(false);
    });

    it("throws for anybody it refuses", async () => {
        ownedByOwner();
        await expect(requireOrgDeletion({ id: "member-1", isAdmin: false }, ORG)).rejects.toThrow();
        await expect(requireOrgDeletion({ id: OWNER, isAdmin: false }, ORG)).resolves.toBeUndefined();
    });
});
