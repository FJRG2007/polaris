/**
 * Many people's standing in a space at once.
 *
 * `spaceStandings` is what a screen asks when it has a list of people to judge
 * - the soundboard's denials, its administrators - and it must answer exactly
 * what `spaceAccess` answers for each of them alone, in a fixed number of reads
 * however long the list is. Every way into a space is here: owning it, the
 * member list, an internal space's organization, and a grant to a person, a
 * team or a role.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "space";
const ORG = "org";

interface World {
    space: { id: string; ownerId: string; orgId: string | null; visibility: string };
    orgOwnerId: string;
    members: { userId: string; role: string }[];
    orgMembers: { userId: string; orgId: string; role: string; restricted: boolean }[];
    teams: { userId: string; teamId: string }[];
    roles: { id: string; orgId: string; slug: string }[];
    grants: Record<string, unknown>[];
}

let world: World;
let reads: Record<string, number> = {};

function read(table: string): void {
    reads[table] = (reads[table] ?? 0) + 1;
}

function handedTo(principalType: string, principalId: string, capability: string) {
    return {
        id: `${principalType}:${principalId}`,
        subjectType: "chat.space",
        subjectId: SPACE,
        principalType,
        principalId,
        capability,
        startsAt: null,
        endsAt: null,
        days: core.EVERY_DAY,
        startMinute: null,
        endMinute: null,
        timeZone: "UTC",
        maxUses: null,
        uses: 0
    };
}

vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async (userId: string) => [
        ...(world.orgOwnerId === userId ? [ORG] : []),
        ...world.orgMembers.filter((row) => row.userId === userId && !row.restricted).map((row) => row.orgId)
    ],
    teamIdsFor: async (userId: string) =>
        world.teams.filter((row) => row.userId === userId).map((row) => row.teamId)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpace: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                read("chatSpace");
                return where.id === world.space.id
                    ? { ...world.space, org: world.space.orgId ? { ownerId: world.orgOwnerId } : null }
                    : null;
            }
        },
        chatSpaceMember: {
            findUnique: async ({ where }: { where: { spaceId_userId: { userId: string } } }) =>
                world.members.find((row) => row.userId === where.spaceId_userId.userId) ?? null,
            findMany: async ({ where }: { where: { userId?: { in: string[] }; role?: string } }) => {
                read("chatSpaceMember");
                return world.members.filter(
                    (row) =>
                        (!where.userId || where.userId.in.includes(row.userId)) &&
                        (!where.role || row.role === where.role)
                );
            }
        },
        organizationMember: {
            findMany: async ({
                where
            }: {
                where: { userId?: string | { in: string[] }; OR?: { orgId: string; role: string }[] };
            }) => {
                read("organizationMember");
                return world.orgMembers.filter((row) => {
                    if (where.OR) return where.OR.some((one) => one.orgId === row.orgId && one.role === row.role);
                    if (typeof where.userId === "string") return row.userId === where.userId;
                    return where.userId!.in.includes(row.userId);
                });
            }
        },
        teamMember: {
            findMany: async ({ where }: { where: { userId?: { in: string[] }; teamId?: { in: string[] } } }) => {
                read("teamMember");
                return world.teams.filter(
                    (row) =>
                        (!where.userId || where.userId.in.includes(row.userId)) &&
                        (!where.teamId || where.teamId.in.includes(row.teamId))
                );
            }
        },
        orgRole: {
            findMany: async ({
                where
            }: {
                where: { id?: { in: string[] }; OR?: { orgId: string; slug: string }[] };
            }) => {
                read("orgRole");
                return world.roles.filter((role) =>
                    where.id
                        ? where.id.in.includes(role.id)
                        : where.OR!.some((one) => one.orgId === role.orgId && one.slug === role.slug)
                );
            }
        },
        accessGrant: {
            findMany: async () => {
                read("accessGrant");
                return world.grants;
            }
        }
    }
}));

const access = await import("@/lib/chat/access");

const PEOPLE = ["owner", "listed-admin", "listed-member", "roster", "restricted", "by-name", "by-team", "by-role", "stranger"];

beforeEach(() => {
    reads = {};
    world = {
        space: { id: SPACE, ownerId: "owner", orgId: ORG, visibility: "internal" },
        orgOwnerId: "org-owner",
        members: [
            { userId: "listed-admin", role: "admin" },
            { userId: "listed-member", role: "member" }
        ],
        orgMembers: [
            { userId: "roster", orgId: ORG, role: "member", restricted: false },
            { userId: "restricted", orgId: ORG, role: "guest", restricted: true },
            { userId: "by-role", orgId: "elsewhere", role: "support", restricted: false }
        ],
        teams: [{ userId: "by-team", teamId: "team" }],
        roles: [{ id: "support-role", orgId: "elsewhere", slug: "support" }],
        grants: [
            handedTo("user", "by-name", "admin"),
            handedTo("team", "team", "member"),
            handedTo("role", "support-role", "admin")
        ]
    };
});

async function oneByOne(): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    for (const id of [...PEOPLE, "org-owner"]) found.set(id, await access.spaceAccess({ id }, SPACE));
    return found;
}

describe("standings in a batch", () => {
    it.each(["internal", "private"])("match one-by-one access in a %s space", async (visibility) => {
        world.space.visibility = visibility;
        const alone = await oneByOne();
        const batch = await access.spaceStandings(SPACE, [...PEOPLE, "org-owner"]);
        expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(alone));
        expect(batch.get("by-name")).toBe("admin");
        expect(batch.get("by-role")).toBe("admin");
        expect(batch.get("by-team")).toBe("member");
        expect(batch.get("stranger")).toBeNull();
    });

    it("read each table once however many people are asked about", async () => {
        const many = [...PEOPLE, ...Array.from({ length: 200 }, (_, index) => `extra-${index}`)];
        await access.spaceStandings(SPACE, many);
        for (const count of Object.values(reads)) expect(count).toBe(1);
    });

    it("skip the grants when everybody was answered the ordinary way", async () => {
        await access.spaceStandings(SPACE, ["owner", "listed-admin", "roster"]);
        expect(reads.accessGrant).toBeUndefined();
    });

    it("answer nobody for a space that is not there", async () => {
        const batch = await access.spaceStandings("gone", ["owner"]);
        expect(batch.get("owner")).toBeNull();
    });
});

describe("the administrators", () => {
    it("are the listed ones and whoever a grant makes one, never the owner", async () => {
        expect((await access.spaceAdminIds(SPACE)).sort()).toEqual(["by-name", "by-role", "listed-admin"]);
    });

    it("leave out somebody a grant names but the space no longer reaches at that level", async () => {
        world.grants = [handedTo("user", "by-name", "admin")];
        world.members.push({ userId: "by-name", role: "member" });
        expect((await access.spaceAdminIds(SPACE)).sort()).toEqual(["listed-admin"]);
    });
});
