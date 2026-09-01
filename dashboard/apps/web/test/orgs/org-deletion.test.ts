/**
 * Who may end an organization.
 *
 * Three names and no fourth: the owner, the successor, and an instance
 * administrator. The tests that matter are the refusals - somebody who runs the
 * organization in every other respect still cannot delete it, and a successor of
 * the wrong person is nobody here.
 *
 * "The successor" is two things and the order between them is the part worth
 * pinning. An organization can name its own, and one that has not falls back to
 * whoever its owner named on their own account. They do not stack: an
 * organization that has chosen somebody has made a choice, and also honouring the
 * owner's personal successor would widen it past what was chosen - which is the
 * one thing a designation like this must never do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const orgFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const successorFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const orgSuccessorFindUnique = vi.fn(async (_args: unknown) => null as unknown);

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: orgFindUnique },
        accountSuccessor: { findUnique: successorFindUnique },
        organizationSuccessor: { findUnique: orgSuccessorFindUnique },
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

/** Whoever `holder` named on their own account. */
function successorOf(holder: string, successorId: string) {
    successorFindUnique.mockImplementation(async (args: unknown) => {
        const where = (args as { where: { userId: string } }).where;
        return where.userId === holder ? { successorId } : null;
    });
}

/** Whoever the organization itself named. */
function orgSuccessorOf(orgId: string, successorId: string) {
    orgSuccessorFindUnique.mockImplementation(async (args: unknown) => {
        const where = (args as { where: { orgId: string } }).where;
        return where.orgId === orgId ? { successorId } : null;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    orgFindUnique.mockResolvedValue(null);
    successorFindUnique.mockResolvedValue(null);
    orgSuccessorFindUnique.mockResolvedValue(null);
});

describe("the organization's own successor", () => {
    it("may end it", async () => {
        ownedByOwner();
        orgSuccessorOf(ORG, "colleague-1");
        expect(await canDeleteOrg({ id: "colleague-1", isAdmin: false }, ORG)).toBe(true);
    });

    it("takes the place of the owner's, rather than adding to it", async () => {
        // The one that would be a quiet widening: an organization that has chosen
        // a colleague must not also still answer to whoever the owner named for
        // their estate.
        ownedByOwner();
        orgSuccessorOf(ORG, "colleague-1");
        successorOf(OWNER, "heir-1");
        expect(await canDeleteOrg({ id: "heir-1", isAdmin: false }, ORG)).toBe(false);
        expect(await canDeleteOrg({ id: "colleague-1", isAdmin: false }, ORG)).toBe(true);
    });

    it("answers for a different organization and not for this one", async () => {
        ownedByOwner();
        orgSuccessorOf("org-2", "colleague-1");
        expect(await canDeleteOrg({ id: "colleague-1", isAdmin: false }, ORG)).toBe(false);
    });
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
