/**
 * Who a grant actually reaches.
 *
 * `access-grants.test.ts` in the core package pins whether a grant is in force;
 * this pins the half that decides whose it is - and that half is where the
 * dangerous mistakes live, because every one of them is somebody reaching
 * something that is not theirs.
 *
 * The rule being pinned is one sentence: **a grant to a group is a grant to
 * whoever is in that group right now.** Not to whoever was in it when it was
 * written, and never to somebody who merely knows the id.
 */

import { EVERY_DAY } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every grant in the world, for the case being run. */
let grants: Record<string, unknown>[] = [];
/** What the caller belongs to. */
let teams: string[] = [];
let memberships: { orgId: string; role: string }[] = [];
let roles: { id: string }[] = [];
/** Which organization the team or role being handed the thing belongs to. */
let principalOrg = "org-a";

const updateMany = vi.fn(async () => ({ count: 1 }));
const update = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        accessGrant: {
            findMany: async ({ where }: { where: { subjectType: string; subjectId?: string } }) =>
                grants.filter(
                    (grant) =>
                        grant.subjectType === where.subjectType &&
                        (where.subjectId === undefined || grant.subjectId === where.subjectId)
                ),
            findUnique: async ({ where }: { where: { id: string } }) =>
                grants.find((grant) => grant.id === where.id) ?? null,
            updateMany,
            update,
            count: async () => grants.length,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                grants.push({ ...data, id: `g${grants.length + 1}` });
                return { id: `g${grants.length}` };
            },
            deleteMany: async () => ({ count: 1 })
        },
        organizationMember: { findMany: async () => memberships },
        orgRole: {
            findMany: async () => roles,
            // A role is only offered by the organization that owns the subject,
            // so the write asks for it scoped rather than by id alone.
            findFirst: async ({ where }: { where: { orgId: { in: string[] } } }) =>
                where.orgId.in.includes(principalOrg) ? { id: "r1" } : null
        },
        user: { findUnique: async () => ({ id: "u1" }), findMany: async () => [] },
        team: {
            findFirst: async ({ where }: { where: { orgId: { in: string[] } } }) =>
                where.orgId.in.includes(principalOrg) ? { id: "t1" } : null,
            findMany: async () => []
        }
    }
}));

vi.mock("@/lib/orgs/org-service", () => ({ teamIdsFor: async () => teams }));

const { grantedCapability, grantedSubjects, liveGrants, spendGrant, writeGrant } = await import(
    "@/lib/access/grants"
);

/** One row, with the shape the reader selects and no bounds unless a case adds
 *  them. */
function grant(over: Record<string, unknown> = {}) {
    return {
        id: "g1",
        subjectType: "place.device",
        subjectId: "d1",
        principalType: "user",
        principalId: "u1",
        capability: "control",
        startsAt: null,
        endsAt: null,
        days: EVERY_DAY,
        startMinute: null,
        endMinute: null,
        timeZone: "UTC",
        maxUses: null,
        uses: 0,
        ...over
    };
}

beforeEach(() => {
    grants = [];
    teams = [];
    memberships = [];
    roles = [];
    principalOrg = "org-a";
    vi.clearAllMocks();
});

describe("who a grant reaches", () => {
    it("reaches the person it names", async () => {
        grants = [grant()];
        expect(await grantedCapability("u1", "place.device", "d1")).toBe("control");
    });

    it("reaches nobody else, however well they know the id", async () => {
        grants = [grant()];
        expect(await grantedCapability("u2", "place.device", "d1")).toBe("");
    });

    it("reaches whoever is on the team it names", async () => {
        grants = [grant({ principalType: "team", principalId: "team-security" })];
        teams = ["team-security"];
        expect(await grantedCapability("u9", "place.device", "d1")).toBe("control");
    });

    it("stops reaching somebody the moment they leave that team", async () => {
        // The whole point of granting to a group: nothing is rewritten, and the
        // row that reached them yesterday reaches nobody today.
        grants = [grant({ principalType: "team", principalId: "team-security" })];
        teams = [];
        expect(await grantedCapability("u9", "place.device", "d1")).toBe("");
    });

    it("reaches whoever holds the role it names, matched by row rather than by name", async () => {
        // A membership stores the role's slug and the grant stores its id; this
        // is the join between the two, and matching on the word "admin" instead
        // is the bug that has bitten this codebase before.
        grants = [grant({ principalType: "role", principalId: "role-support" })];
        memberships = [{ orgId: "o1", role: "support" }];
        roles = [{ id: "role-support" }];
        expect(await grantedCapability("u9", "place.device", "d1")).toBe("control");
    });

    it("reaches nothing at all when the subject has no grants", async () => {
        grants = [];
        expect(await liveGrants("u1", "place.device", "d1")).toEqual([]);
    });

    it("hands over the strongest of several", async () => {
        grants = [
            grant({ id: "g1", capability: "view" }),
            grant({ id: "g2", capability: "control" })
        ];
        expect(await grantedCapability("u1", "place.device", "d1")).toBe("control");
    });

    it("hands over nothing from one that has expired", async () => {
        grants = [grant({ endsAt: new Date("2020-01-01T00:00:00Z") })];
        expect(await grantedCapability("u1", "place.device", "d1")).toBe("");
    });

    it("hands over nothing from one that is used up", async () => {
        grants = [grant({ maxUses: 4, uses: 4 })];
        expect(await grantedCapability("u1", "place.device", "d1")).toBe("");
    });
});

describe("everything of one kind somebody reaches", () => {
    it("answers by id, with the strongest each was given", async () => {
        grants = [
            grant({ id: "g1", subjectId: "d1", capability: "view" }),
            grant({ id: "g2", subjectId: "d1", capability: "control" }),
            grant({ id: "g3", subjectId: "d2", capability: "view" }),
            grant({ id: "g4", subjectId: "d3", capability: "control", uses: 1, maxUses: 1 })
        ];
        const reached = await grantedSubjects("u1", "place.device");
        expect([...reached.entries()].sort()).toEqual([
            ["d1", "control"],
            ["d2", "view"]
        ]);
    });
});

describe("spending one", () => {
    it("counts a use, and only against a grant that has a limit", async () => {
        grants = [grant({ maxUses: 4, uses: 0 })];
        const [held] = await liveGrants("u1", "place.device", "d1");
        expect(held?.counted).toBe(true);
        expect(await spendGrant(held!)).toBe(true);
        expect(updateMany).toHaveBeenCalledOnce();
        // Bounded in the statement, so two presses arriving together cannot both
        // find the last use free.
        expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
            where: { id: "g1", uses: { lt: 4 } }
        });
    });

    it("marks an unlimited one as used without counting anything", async () => {
        grants = [grant()];
        const [held] = await liveGrants("u1", "place.device", "d1");
        expect(held?.counted).toBe(false);
        expect(await spendGrant(held!)).toBe(true);
        // `updateMany` even here: a grant taken back between the check and the
        // act is a row that is gone, and `update` would raise over a stamp.
        expect(update).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledOnce();
        expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: "g1" } });
    });
});

describe("writing one", () => {
    /** A written grant, with only the parts a case cares about spelled out. */
    function writing(over: Record<string, unknown> = {}) {
        return {
            principalType: "user",
            principalId: "u1",
            capability: "control",
            days: EVERY_DAY,
            startMinute: null,
            endMinute: null,
            timeZone: "",
            maxUses: null,
            note: "",
            ...over
        } as Parameters<typeof writeGrant>[2];
    }

    it("refuses a capability the subject does not have", async () => {
        // `admin` is a space's word, not a door's. A stored row nobody can read
        // would reach nothing, but it would also sit on a screen looking like
        // access somebody has.
        await expect(
            writeGrant("place.device", "d1", writing({ capability: "admin" }), "u0", ["org-a"])
        ).rejects.toThrow(/shared as/);
    });

    it("hands a thing to a team of the organization that owns it", async () => {
        principalOrg = "org-a";
        await expect(
            writeGrant(
                "place.device",
                "d1",
                writing({ principalType: "team", principalId: "t1" }),
                "u0",
                ["org-a"]
            )
        ).resolves.toBeTruthy();
    });

    it("refuses a team of another organization, whatever the picker offered", async () => {
        // The picker only ever offers the owning organization's groups, but a
        // picker is a screen: the rule has to hold against a call that was not
        // made by one.
        principalOrg = "org-b";
        await expect(
            writeGrant(
                "place.device",
                "d1",
                writing({ principalType: "team", principalId: "t1" }),
                "u0",
                ["org-a"]
            )
        ).rejects.toThrow(/team or role/);
    });

    it("refuses a role when no organization is on the table at all", async () => {
        await expect(
            writeGrant(
                "place.device",
                "d1",
                writing({ principalType: "role", principalId: "r1" }),
                "u0",
                []
            )
        ).rejects.toThrow(/team or role/);
    });

    it("still hands a thing to a person, who belongs to no organization here", async () => {
        await expect(writeGrant("place.device", "d1", writing(), "u0", [])).resolves.toBeTruthy();
    });
});
