/**
 * Being asked to join an organization, and answering.
 *
 * The rule this exists to hold: **nobody lands on a roster without saying yes.**
 * Polaris used to write the membership row on the spot, so somebody could put
 * another person's account on a roster - published to everybody else on it,
 * under a role they never saw. The invitation is the fix, and the ways it can
 * quietly stop being one are what is asserted here:
 *
 * - inviting must write an invitation and never a membership;
 * - only the person asked may answer, since nothing else can be checked for
 *   them;
 * - an invitation that has run out is not an invitation;
 * - the size limit has to count invitations, or an organization can promise
 *   more places than it has.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    /** The account the identifier resolves to. */
    user: null as { id: string; bannedAt: Date | null } | null,
    org: { ownerId: "owner-1", name: "Acme", slug: "acme" } as {
        ownerId: string;
        name: string;
        slug: string;
    } | null,
    /** Whether the invited account is already on the roster. */
    member: null as { id: string } | null,
    /** Whether the role named still exists. */
    role: { id: "role-1" } as { id: string } | null,
    memberCount: 0,
    invitationCount: 0,
    invitation: null as
        | {
              id: string;
              role: string;
              userId: string;
              expiresAt: Date;
              invitedById: string;
              org: { id: string; name: string; slug: string };
          }
        | null,
    /** Whose invitation the room check left out of its count. */
    countedExcluding: null as string | null,
    /** What was written, in order, so a test can say what did and did not
     *  happen. */
    written: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findFirst: async () => state.user,
            findUnique: async () => ({ name: "Ada", username: "ada" })
        },
        organization: { findUnique: async () => state.org },
        organizationMember: {
            findUnique: async () => state.member,
            count: async () => state.memberCount,
            upsert: async () => {
                state.written.push("member");
                return {};
            }
        },
        organizationInvitation: {
            // Every count here excludes the person being made room for, so a
            // test says how many OTHER invitations are outstanding.
            count: async ({ where }: { where: { userId?: { not: string } } }) => {
                state.countedExcluding = where.userId?.not ?? null;
                return state.invitationCount;
            },
            findUnique: async () => state.invitation,
            findMany: async () => [],
            upsert: async () => {
                state.written.push("invitation");
                return {};
            },
            deleteMany: async () => {
                state.written.push("invitation-gone");
                return { count: 1 };
            }
        },
        orgRole: { findUnique: async () => state.role },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

vi.mock("@/lib/orgs/policy", () => ({ organizationPolicy: async () => ({ maxMembers: 3 }) }));
vi.mock("@/lib/orgs/role-service", () => ({ ensureSystemRoles: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/privacy-service", () => ({ contactLines: async () => new Map<string, string>() }));

const { inviteToOrg, respondToInvitation } = await import("@/lib/orgs/invitation-service");
const { OrgError } = await import("@/lib/orgs/errors");

const hour = 60 * 60 * 1000;

beforeEach(() => {
    state.user = { id: "invitee", bannedAt: null };
    state.org = { ownerId: "owner-1", name: "Acme", slug: "acme" };
    state.member = null;
    state.role = { id: "role-1" };
    state.memberCount = 0;
    state.invitationCount = 0;
    state.invitation = {
        id: "inv-1",
        role: "member",
        userId: "invitee",
        expiresAt: new Date(Date.now() + 24 * hour),
        invitedById: "owner-1",
        org: { id: "org-1", name: "Acme", slug: "acme" }
    };
    state.countedExcluding = null;
    state.written = [];
});

describe("inviting somebody", () => {
    it("writes an invitation and never a membership", async () => {
        await inviteToOrg("org-1", "ada@example.com", "member", "owner-1");
        expect(state.written).toEqual(["invitation"]);
    });

    it("refuses the owner, who is already answerable for it", async () => {
        state.user = { id: "owner-1", bannedAt: null };
        await expect(inviteToOrg("org-1", "owner", "member", "owner-1")).rejects.toBeInstanceOf(
            OrgError
        );
        expect(state.written).toEqual([]);
    });

    it("refuses somebody already on the roster", async () => {
        state.member = { id: "membership-1" };
        await expect(inviteToOrg("org-1", "ada", "member", "owner-1")).rejects.toBeInstanceOf(
            OrgError
        );
    });

    it("refuses a role this organization does not have", async () => {
        state.role = null;
        await expect(inviteToOrg("org-1", "ada", "invented", "owner-1")).rejects.toBeInstanceOf(
            OrgError
        );
    });

    it("leaves the invited person's own invitation out of the count", async () => {
        // Re-inviting somebody at a different role is the same person asking for
        // the same place. Counting the invitation already on the table as well
        // refuses the change on a full roster, which the direct add it replaced
        // explicitly did not do.
        state.memberCount = 1;
        state.invitationCount = 0;
        await inviteToOrg("org-1", "ada", "admin", "owner-1");
        expect(state.countedExcluding).toBe("invitee");
        expect(state.written).toEqual(["invitation"]);
    });

    it("counts invitations against the size limit", async () => {
        // Two members and one invitation is three places in a Polaris that
        // allows three - counting the owner, who is never a member row. Asking a
        // fourth person would be promising a place that does not exist.
        state.memberCount = 2;
        state.invitationCount = 1;
        await expect(inviteToOrg("org-1", "ada", "member", "owner-1")).rejects.toBeInstanceOf(
            OrgError
        );
        expect(state.written).toEqual([]);
    });
});

describe("answering one", () => {
    it("joins the roster and clears the invitation", async () => {
        await respondToInvitation("invitee", "inv-1", true);
        expect(state.written).toEqual(["member", "invitation-gone"]);
    });

    it("clears it and joins nothing when it is turned down", async () => {
        await respondToInvitation("invitee", "inv-1", false);
        expect(state.written).toEqual(["invitation-gone"]);
    });

    it("does not count the accepting person twice", async () => {
        // Their own invitation is still on the table while they answer it, and
        // counting it as well as the place it asks for is one person taking two.
        // An owner, one member and this invitation is three places in a Polaris
        // that allows three, so this must go through.
        state.memberCount = 1;
        state.invitationCount = 0;
        await respondToInvitation("invitee", "inv-1", true);
        expect(state.countedExcluding).toBe("invitee");
        expect(state.written).toEqual(["member", "invitation-gone"]);
    });

    it("is refused to anybody but the person asked", async () => {
        // The one check nobody else can make on their behalf: an invitation is
        // not a permission somebody in the organization holds.
        await expect(respondToInvitation("stranger", "inv-1", true)).rejects.toBeInstanceOf(
            OrgError
        );
        expect(state.written).toEqual([]);
    });

    it("refuses one that has run out, and clears it away", async () => {
        state.invitation = { ...state.invitation!, expiresAt: new Date(Date.now() - hour) };
        await expect(respondToInvitation("invitee", "inv-1", true)).rejects.toBeInstanceOf(OrgError);
        expect(state.written).toEqual(["invitation-gone"]);
    });

    it("refuses a role that was deleted while it was waiting", async () => {
        // Otherwise the membership would name a slug nothing defines, which
        // resolves to the seeded fallback - granting something nobody chose.
        state.role = null;
        await expect(respondToInvitation("invitee", "inv-1", true)).rejects.toBeInstanceOf(OrgError);
        expect(state.written).toEqual([]);
    });
});
