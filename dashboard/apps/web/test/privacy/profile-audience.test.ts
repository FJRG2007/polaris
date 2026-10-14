/**
 * Who may read somebody's profile, and the spaces that answer it.
 *
 * Five answers somebody can give - everybody, friends and anybody in a server
 * with them, friends and anybody in a small server with them, friends, nobody -
 * asked of every relation a reader can have to them. Then the one number that
 * decides "small", at the edge where it flips, read the way the service reads
 * it: the owner is not a member row and still counts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Spaces as the database holds them: an owner and the member rows. */
let spaces: { id: string; ownerId: string; archived: boolean; members: string[] }[] = [];
/** What each account stored for `profile`. Absent means no row. */
let stored = new Map<string, string>();
let friends = new Set<string>();
let counts = 0;
/** Reads that need a viewer id: their friends and their spaces. */
let lookups = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => stored.has(userId))
                    .map((userId) => ({ userId, profile: stored.get(userId) }))
        },
        privacyFieldList: { findMany: async () => [] },
        privacyListMember: { findMany: async () => [] },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] },
        chatSpace: {
            findMany: async ({ where }: { where: { OR: [{ ownerId: string }, unknown] } }) => {
                lookups += 1;
                const viewerId = where.OR[0].ownerId;
                return spaces
                    .filter((space) => !space.archived)
                    .filter((space) => space.ownerId === viewerId || space.members.includes(viewerId))
                    .map((space) => ({ id: space.id, ownerId: space.ownerId }));
            }
        },
        chatSpaceMember: {
            findMany: async ({ where }: { where: { spaceId: { in: string[] }; userId: { in: string[] } } }) =>
                spaces
                    .filter((space) => where.spaceId.in.includes(space.id))
                    .flatMap((space) =>
                        space.members
                            .filter((userId) => where.userId.in.includes(userId))
                            .map((userId) => ({ spaceId: space.id, userId }))
                    ),
            groupBy: async ({ where }: { where: { spaceId: { in: string[] } } }) => {
                counts += 1;
                return spaces
                    .filter((space) => where.spaceId.in.includes(space.id))
                    .map((space) => ({ spaceId: space.id, _count: { _all: space.members.length } }));
            }
        }
    }
}));

vi.mock("@/lib/friends-service", () => ({
    friendIds: async () => {
        lookups += 1;
        return friends;
    }
}));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null, setSetting: async () => {} }));

const core = await import("@polaris/core");
const { allowedBy } = await import("@/lib/privacy-service");

const viewer = { id: "viewer", isAdmin: false };

/** A space of exactly `people` people, owner included, holding `who` too. */
function space(id: string, people: number, who: readonly string[]) {
    const fillers = Array.from({ length: people - 1 - who.length }, (_, i) => `${id}-filler-${i}`);
    return { id, ownerId: `${id}-owner`, archived: false, members: [...who, ...fillers] };
}

async function sees(subject: string, audience: string): Promise<boolean> {
    stored.set(subject, audience);
    return (await allowedBy(viewer, "profile", [subject])).has(subject);
}

beforeEach(() => {
    spaces = [];
    stored = new Map();
    friends = new Set();
    counts = 0;
    lookups = 0;
});

describe("the rule, for every answer and every relation", () => {
    const relations = {
        self: { self: true, friends: false, viewerIsAdmin: false },
        admin: { self: false, friends: false, viewerIsAdmin: true },
        friend: { self: false, friends: true, viewerIsAdmin: false },
        smallSpaceMate: {
            self: false,
            friends: false,
            viewerIsAdmin: false,
            sharesSpace: true,
            sharesSmallSpace: true
        },
        largeSpaceMate: {
            self: false,
            friends: false,
            viewerIsAdmin: false,
            sharesSpace: true,
            sharesSmallSpace: false
        },
        stranger: { self: false, friends: false, viewerIsAdmin: false }
    } as const;

    const expected: Record<string, Record<keyof typeof relations, boolean>> = {
        everyone: { self: true, admin: true, friend: true, smallSpaceMate: true, largeSpaceMate: true, stranger: true },
        spaces: { self: true, admin: true, friend: true, smallSpaceMate: true, largeSpaceMate: true, stranger: false },
        smallSpaces: {
            self: true,
            admin: true,
            friend: true,
            smallSpaceMate: true,
            largeSpaceMate: false,
            stranger: false
        },
        friends: { self: true, admin: true, friend: true, smallSpaceMate: false, largeSpaceMate: false, stranger: false },
        nobody: { self: true, admin: true, friend: false, smallSpaceMate: false, largeSpaceMate: false, stranger: false }
    };

    for (const [audience, answers] of Object.entries(expected)) {
        for (const [relation, allowed] of Object.entries(answers)) {
            it(`${audience} ${allowed ? "shows" : "hides"} it to a ${relation}`, () => {
                expect(
                    core.audienceAllows(
                        audience as (typeof core.PRIVACY_AUDIENCES)[number],
                        relations[relation as keyof typeof relations]
                    )
                ).toBe(allowed);
            });
        }
    }

    it("closes the space audiences when nobody looked the spaces up", () => {
        const stranger = { self: false, friends: false, viewerIsAdmin: false };
        expect(core.audienceAllows("spaces", stranger)).toBe(false);
        expect(core.audienceAllows("smallSpaces", stranger)).toBe(false);
    });
});

describe("an account that never chose", () => {
    it("shows its profile to everybody, as before the setting existed", async () => {
        expect(core.DEFAULT_PRIVACY.profile.audience).toBe("everyone");
        expect(core.storedAudience("profile", undefined)).toBe("everyone");
        expect(await allowedBy(viewer, "profile", ["no-row"])).toEqual(new Set(["no-row"]));
    });
});

describe("what counts as small", () => {
    it("offers exactly the five profile answers", () => {
        expect([...core.PROFILE_AUDIENCES]).toEqual(["everyone", "spaces", "smallSpaces", "friends", "nobody"]);
    });

    it("is fewer than 200 people", () => {
        expect(core.SMALL_SPACE_MEMBERS).toBe(200);
        expect(core.isSmallSpace(199)).toBe(true);
        expect(core.isSmallSpace(200)).toBe(false);
    });

    it("counts the owner, who is not a member row: 199 people is small", async () => {
        spaces = [space("s", 199, ["viewer", "subject"])];
        expect(await sees("subject", "smallSpaces")).toBe(true);
    });

    it("200 people, owner included, is not", async () => {
        spaces = [space("s", 200, ["viewer", "subject"])];
        expect(await sees("subject", "smallSpaces")).toBe(false);
        expect(await sees("subject", "spaces")).toBe(true);
    });

    it("answers yes when any one shared space is small", async () => {
        spaces = [space("big", 500, ["viewer", "subject"]), space("small", 5, ["viewer", "subject"])];
        expect(await sees("subject", "smallSpaces")).toBe(true);
    });

    it("counts the owner of a space as in it", async () => {
        spaces = [{ id: "s", ownerId: "subject", archived: false, members: ["viewer"] }];
        expect(await sees("subject", "smallSpaces")).toBe(true);
    });

    it("leaves archived spaces out", async () => {
        spaces = [{ ...space("s", 3, ["viewer", "subject"]), archived: true }];
        expect(await sees("subject", "spaces")).toBe(false);
    });

    it("does not count spaces the viewer is not in", async () => {
        spaces = [space("theirs", 3, ["subject"])];
        expect(await sees("subject", "spaces")).toBe(false);
    });

    it("lets a friend in without a shared space", async () => {
        friends = new Set(["subject"]);
        expect(await sees("subject", "smallSpaces")).toBe(true);
    });
});

describe("a page of people", () => {
    it("counts members once for the whole page, not once per person", async () => {
        const people = Array.from({ length: 30 }, (_, i) => `p${i}`);
        spaces = [space("s", 50, ["viewer", ...people])];
        for (const person of people) stored.set(person, "smallSpaces");
        const allowed = await allowedBy(viewer, "profile", people);
        expect(allowed.size).toBe(30);
        expect(counts).toBe(1);
    });

    it("never asks about spaces when nobody's answer turns on them", async () => {
        stored.set("a", "friends");
        stored.set("b", "everyone");
        await allowedBy(viewer, "profile", ["a", "b"]);
        expect(counts).toBe(0);
    });
});

describe("a reader with no account", () => {
    const anonymous = { id: "", isAdmin: false };

    it("is shown only what is shown to everybody, without looking up who they know", async () => {
        stored.set("open", "everyone");
        for (const audience of ["spaces", "smallSpaces", "friends", "nobody"]) stored.set(audience, audience);
        const allowed = await allowedBy(anonymous, "profile", ["open", "spaces", "smallSpaces", "friends", "nobody"]);
        expect(allowed).toEqual(new Set(["open"]));
        expect(lookups).toBe(0);
    });
});
