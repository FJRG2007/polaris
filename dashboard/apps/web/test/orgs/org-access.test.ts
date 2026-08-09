/**
 * How an organization's space answers "may they".
 *
 * The rules that are easy to get wrong, and expensive when they are: being on a
 * roster must not by itself reach any work, a team grant must, `internal` on an
 * organization's space must mean that roster rather than the whole instance, and
 * two ways in must add up rather than the last one read winning.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = { id: "u1", isAdmin: false };

const spaceFindUnique = vi.fn(async (_args: unknown) => null as unknown);

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace: { findUnique: spaceFindUnique },
        taskFolder: { findMany: vi.fn(async () => []) },
        taskFolderMember: { findMany: vi.fn(async () => []) },
        taskFolderTeam: { findMany: vi.fn(async () => []) },
        organization: { findMany: vi.fn(async () => []) },
        organizationMember: { findMany: vi.fn(async () => []) }
    }
}));

// Access written for one space alone is a fifth way in, resolved in @polaris/auth
// against tables these cases do not set up. Answering "none" keeps each case about
// the way in it is actually pinning: membership, a team, or the organization.
vi.mock("@polaris/auth", () => ({
    canOn: async () => false,
    grantedResourceIds: async () => ({ ids: [], everyOne: false })
}));

const { resolveSpaceRole } = await import("../../src/lib/tasks/access");

/** One space, described by the ways in it offers this reader. Every field is
 *  what the query actually selects, filtered to them. */
function space(options: {
    visibility?: string;
    ownerId?: string;
    orgId?: string | null;
    members?: { role: string }[];
    teamGrants?: { role: string }[];
    org?: { ownerId: string; members: { role: string }[]; roles?: { slug: string; permissions: string }[] } | null;
}) {
    return {
        ownerId: options.ownerId ?? "someone-else",
        visibility: options.visibility ?? "private",
        orgId: options.orgId ?? null,
        members: options.members ?? [],
        teamGrants: options.teamGrants ?? [],
        // An organization with no role rows is the migrated case: the slugs on
        // its memberships still mean what Polaris seeds them as.
        org: options.org ? { roles: [], ...options.org } : null
    };
}

describe("what an organization's space gives somebody", () => {
    beforeEach(() => vi.clearAllMocks());

    it("gives a plain member of the organization nothing", async () => {
        spaceFindUnique.mockResolvedValue(
            space({ orgId: "o1", org: { ownerId: "someone-else", members: [{ role: "member" }] } })
        );

        expect(await resolveSpaceRole(READER, "s1")).toBeNull();
    });

    it("gives whoever runs the organization the space it owns", async () => {
        spaceFindUnique.mockResolvedValue(
            space({ orgId: "o1", org: { ownerId: "someone-else", members: [{ role: "admin" }] } })
        );
        expect(await resolveSpaceRole(READER, "s1")).toBe("admin");

        spaceFindUnique.mockResolvedValue(space({ orgId: "o1", org: { ownerId: READER.id, members: [] } }));
        expect(await resolveSpaceRole(READER, "s1")).toBe("owner");
    });

    it("reads the organization's own role rather than matching on the name 'admin'", async () => {
        // An organization names its own roles. Matching the slug would list this
        // space to somebody the roster says runs the work, then refuse them when
        // they opened it.
        spaceFindUnique.mockResolvedValue(
            space({
                orgId: "o1",
                org: {
                    ownerId: "someone-else",
                    members: [{ role: "ops" }],
                    roles: [{ slug: "ops", permissions: JSON.stringify(["spaces.manage"]) }]
                }
            })
        );
        expect(await resolveSpaceRole(READER, "s1")).toBe("admin");

        // And a role called "admin" that was narrowed to not run the work does
        // not administer it either.
        spaceFindUnique.mockResolvedValue(
            space({
                orgId: "o1",
                org: {
                    ownerId: "someone-else",
                    members: [{ role: "desk" }],
                    roles: [{ slug: "desk", permissions: JSON.stringify(["people.manage"]) }]
                }
            })
        );
        expect(await resolveSpaceRole(READER, "s1")).toBeNull();
    });

    it("gives a team's people the role the team was granted", async () => {
        spaceFindUnique.mockResolvedValue(
            space({
                orgId: "o1",
                teamGrants: [{ role: "member" }],
                org: { ownerId: "someone-else", members: [{ role: "member" }] }
            })
        );

        expect(await resolveSpaceRole(READER, "s1")).toBe("member");
    });

    it("adds a team grant to a personal membership rather than replacing it", async () => {
        // Guest as a person, member through a team: the answer has to be the
        // stronger of the two, whichever order they were read in.
        spaceFindUnique.mockResolvedValue(
            space({
                orgId: "o1",
                members: [{ role: "guest" }],
                teamGrants: [{ role: "admin" }],
                org: { ownerId: "someone-else", members: [{ role: "member" }] }
            })
        );

        expect(await resolveSpaceRole(READER, "s1")).toBe("admin");
    });

    it("keeps an internal organization space inside that organization", async () => {
        // On the roster: readable.
        spaceFindUnique.mockResolvedValue(
            space({
                visibility: "internal",
                orgId: "o1",
                org: { ownerId: "someone-else", members: [{ role: "member" }] }
            })
        );
        expect(await resolveSpaceRole(READER, "s1")).toBe("guest");

        // Not on it: invisible, even though the instance already trusts them
        // with the app.
        spaceFindUnique.mockResolvedValue(
            space({ visibility: "internal", orgId: "o1", org: { ownerId: "someone-else", members: [] } })
        );
        expect(await resolveSpaceRole(READER, "s1")).toBeNull();
    });

    it("leaves a personal internal space readable by the instance, as it was", async () => {
        spaceFindUnique.mockResolvedValue(space({ visibility: "internal" }));

        expect(await resolveSpaceRole(READER, "s1")).toBe("guest");
    });
});
