/**
 * Who may be put into a group conversation.
 *
 * Friends, and colleagues counted as friends - never somebody whose request is
 * still waiting, never a stranger, and never across a block in either direction.
 * Asked on every way a group gains a member: starting one, adding to one, and a
 * one-to-one call growing into one. A one-to-one conversation keeps its own,
 * wider rule, and nobody already in a group is ever taken out of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Friendship = { requesterId: string; addresseeId: string; status: "pending" | "accepted" };

let friendships: Friendship[] = [];
let blocks: { blockerId: string; blockedId: string }[] = [];
/** The organization ada is in, and who else is in it. Empty: nobody. */
let colleagues: string[] = [];
/** Who is in the group being added to. */
let members: string[] = [];
/** The organization a group is filed under, and its roster. */
let groupOrgId: string | null = null;
let roster: string[] = [];
let created: { kind: string; members: string[] } | null = null;
let added: string[] | null = null;
let removed: string[] = [];

/** Each account's own "who can add me to groups"; absent is never chosen. */
let groupAdds = new Map<string, string>();

/** Who was asked to join instead of being added, by the last add. */
let invitedNow: string[] = [];

vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/group-invites", () => ({
    inviteToGroup: async (_actor: unknown, _channelId: string, ids: readonly string[]) => {
        invitedNow = [...ids];
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    getSettings: async () => new Map(),
    setSetting: async () => undefined
}));
vi.mock("@/lib/friends-service", () => ({
    friendIds: async (userId: string) =>
        new Set(
            friendships
                .filter(
                    (row) =>
                        row.status === "accepted" &&
                        (row.requesterId === userId || row.addresseeId === userId)
                )
                .map((row) => (row.requesterId === userId ? row.addresseeId : row.requesterId))
        )
}));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async (userId: string) =>
        userId === "ada" && colleagues.length ? ["org-1"] : [],
    readsOrgWhere: () => ({})
}));
vi.mock("@/lib/chat/isolation", () => ({
    currentChatOrgId: async () => null,
    orgChatPeople: async () => new Set(roster),
    readableChatScopes: async () => new Set([null])
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postNotice: async () => undefined,
    postSpaceNotice: async () => undefined
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/access");
    return {
        ...actual,
        requireChannel: async () => ({ kind: "group", spaceId: null, mayAdminister: false }),
        invitesAllowed: () => true,
        messageable: async (ids: readonly string[]) => new Set(ids)
    };
});

const NAMES: Record<string, string> = {
    grace: "Grace",
    alan: "Alan",
    hopper: "Hopper",
    turing: "Turing",
    linus: "Linus"
};

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => groupAdds.has(userId))
                    .map((userId) => ({ userId, groupAdds: groupAdds.get(userId) }))
        },
        privacyFieldList: { findMany: async () => [] },
        privacyListMember: { findMany: async () => [] },
        follow: { findMany: async () => [] },
        userBlock: {
            findMany: async ({
                where
            }: {
                where: { OR: [{ blockerId: string; blockedId: { in: string[] } }, unknown] };
            }) => {
                const self = where.OR[0].blockerId;
                const wanted = where.OR[0].blockedId.in;
                return blocks.filter(
                    (row) =>
                        (row.blockerId === self && wanted.includes(row.blockedId)) ||
                        (row.blockedId === self && wanted.includes(row.blockerId))
                );
            }
        },
        friendship: {
            findMany: async ({
                where
            }: {
                where: { OR: [{ requesterId: string; addresseeId: { in: string[] } }, unknown] };
            }) => {
                const self = where.OR[0].requesterId;
                const wanted = where.OR[0].addresseeId.in;
                return friendships.filter(
                    (row) =>
                        (row.requesterId === self && wanted.includes(row.addresseeId)) ||
                        (row.addresseeId === self && wanted.includes(row.requesterId))
                );
            }
        },
        organizationMember: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((id) => colleagues.includes(id))
                    .map((userId) => ({ userId }))
        },
        organization: { findMany: async () => [] },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: NAMES[id] ?? id })),
            findUnique: async ({ where }: { where: { id: string } }) => ({
                name: NAMES[where.id] ?? "",
                username: where.id
            })
        },
        chatChannel: {
            findUnique: async ({ where }: { where: { id?: string; dmKey?: string } }) =>
                where.dmKey
                    ? null
                    : {
                          kind: "group",
                          spaceId: null,
                          ownerId: "ada",
                          createdById: "ada",
                          membersMayInvite: true,
                          orgId: groupOrgId
                      },
            create: async ({
                data
            }: {
                data: { kind: string; members: { createMany: { data: { userId: string }[] } } };
            }) => {
                created = {
                    kind: data.kind,
                    members: data.members.createMany.data.map((row) => row.userId)
                };
                return { id: "new-channel" };
            }
        },
        chatChannelMember: {
            count: async ({ where }: { where?: { userId?: { in: string[] } } }) =>
                where?.userId?.in
                    ? members.filter((id) => where.userId!.in.includes(id)).length
                    : members.length,
            findMany: async ({ where }: { where: { userId?: { in: string[] } } }) =>
                members
                    .filter((id) => where.userId?.in?.includes(id) ?? true)
                    .map((userId) => ({ userId })),
            createMany: async ({ data }: { data: { userId: string }[] }) => {
                added = data.map((row) => row.userId);
                return { count: data.length };
            },
            deleteMany: async ({ where }: { where: { userId: string } }) => {
                removed.push(where.userId);
                return { count: 1 };
            }
        }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const reach = await import("@/lib/chat/group-reach");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };

function friends(other: string, status: Friendship["status"] = "accepted", askedBy = "ada") {
    friendships.push(
        askedBy === "ada"
            ? { requesterId: "ada", addresseeId: other, status }
            : { requesterId: other, addresseeId: "ada", status }
    );
}

beforeEach(() => {
    friendships = [];
    blocks = [];
    colleagues = [];
    members = ["ada", "grace"];
    groupOrgId = null;
    roster = [];
    created = null;
    added = null;
    removed = [];
    groupAdds = new Map();
    invitedNow = [];
});

/** Every way a group gains a member, run against the same cases. */
const paths = {
    "starting a group": (people: string[]) => chat.openDirect(ada, ["grace", ...people]),
    // Adding to a group that exists asks whoever refuses instead of failing
    // (ledger row 16); for the table below that is "not added", said as a throw.
    "adding to a group": async (people: string[]) => {
        const result = await chat.addChannelMembers(ada, "group-1", people);
        if (result && result.invited.length > 0) throw new InvitedInstead(result.invited);
    }
} as const;

/** Whoever an add to an existing group asked rather than added. */
class InvitedInstead extends Error {
    constructor(readonly people: string[]) {
        super("invited instead");
    }
}

/** What "refused" looks like on each path: a refusal, or an invitation. */
function refusalOn(path: string) {
    return path === "starting a group" ? reach.GroupStrangerError : InvitedInstead;
}

describe.each(Object.entries(paths))("%s", (path, run) => {
    beforeEach(() => friends("grace"));

    it("takes a stranger whose own group adds are open to everybody", async () => {
        groupAdds.set("alan", "everyone");
        await expect(run(["alan"])).resolves.not.toThrow();
    });

    it("refuses a friend who shut their group adds to nobody", async () => {
        friends("alan");
        groupAdds.set("alan", "nobody");
        await expect(run(["alan"])).rejects.toBeInstanceOf(refusalOn(path));
    });

    it("refuses a colleague who shut their group adds, and a blocked person even when open", async () => {
        colleagues = ["alan"];
        groupAdds.set("alan", "nobody");
        await expect(run(["alan"])).rejects.toBeInstanceOf(refusalOn(path));
        groupAdds.set("hopper", "everyone");
        blocks = [{ blockerId: "hopper", blockedId: "ada" }];
        await expect(run(["hopper"])).rejects.toBeInstanceOf(ChatAccessError);
    });

    it("takes a friend, whichever of the two asked", async () => {
        friends("alan", "accepted", "alan");
        await expect(run(["alan"])).resolves.not.toThrow();
        expect([...(created?.members ?? []), ...(added ?? [])]).toContain("alan");
    });

    it("refuses somebody whose request is still waiting, in either direction", async () => {
        friends("alan", "pending");
        await expect(run(["alan"])).rejects.toBeInstanceOf(refusalOn(path));
        friendships = [{ requesterId: "grace", addresseeId: "ada", status: "accepted" }];
        friends("alan", "pending", "alan");
        await expect(run(["alan"])).rejects.toBeInstanceOf(refusalOn(path));
        expect(created).toBeNull();
        expect(added).toBeNull();
    });

    it("refuses a stranger, and names them so the screen can say who", async () => {
        const refusal = await run(["alan"]).catch((caught: unknown) => caught);
        expect(refusal).toBeInstanceOf(refusalOn(path));
        if (refusal instanceof InvitedInstead) expect(refusal.people).toEqual(["alan"]);
        else
            expect((refusal as InstanceType<typeof ChatAccessError>).text).toEqual({
                key: "errors.groupNotFriends",
                params: { name: "Alan", others: 0 }
            });
        expect(created).toBeNull();
        expect(added).toBeNull();
    });

    it("counts the rest when several are refused at once", async () => {
        const refusal = await run(["alan", "hopper", "turing"]).catch((caught: unknown) => caught);
        if (refusal instanceof InvitedInstead) expect(refusal.people).toHaveLength(3);
        else
            expect((refusal as InstanceType<typeof ChatAccessError>).text.params).toMatchObject({
                others: 2
            });
    });

    it("refuses the whole request when one of several is a stranger", async () => {
        friends("alan");
        await expect(run(["alan", "hopper"])).rejects.toBeInstanceOf(refusalOn(path));
        expect(created).toBeNull();
        // Starting a group refuses all of it; adding takes the friend and asks
        // the stranger.
        if (path === "starting a group") expect(added).toBeNull();
        else expect([added, invitedNow]).toEqual([["alan"], ["hopper"]]);
    });

    it("refuses a friend the actor has blocked, with the sentence every block gives", async () => {
        friends("alan");
        blocks = [{ blockerId: "ada", blockedId: "alan" }];
        const refusal = await run(["alan"]).catch((caught: unknown) => caught);
        expect(refusal).toBeInstanceOf(ChatAccessError);
        expect(refusal).not.toBeInstanceOf(reach.GroupStrangerError);
        expect((refusal as InstanceType<typeof ChatAccessError>).text.key).toBe(
            "errors.cannotStartConversation"
        );
    });

    it("refuses a friend who has blocked the actor, saying nothing about who decided", async () => {
        friends("alan");
        blocks = [{ blockerId: "alan", blockedId: "ada" }];
        const refusal = await run(["alan"]).catch((caught: unknown) => caught);
        expect((refusal as InstanceType<typeof ChatAccessError>).text.key).toBe(
            "errors.cannotStartConversation"
        );
    });

    it("takes a colleague as a friend - the rule calls and file transfers already follow", async () => {
        colleagues = ["alan"];
        await expect(run(["alan"])).resolves.not.toThrow();
    });

    it("refuses somebody who was a friend and no longer is", async () => {
        friends("alan");
        await expect(run(["alan"])).resolves.not.toThrow();
        friendships = friendships.filter((row) => row.addresseeId !== "alan");
        created = null;
        added = null;
        await expect(run(["alan"])).rejects.toBeInstanceOf(refusalOn(path));
    });
});

describe("a one-to-one conversation", () => {
    it("keeps its own rule: anybody with the chat who has not blocked either way", async () => {
        await expect(chat.openDirect(ada, ["alan"])).resolves.toBe("new-channel");
        expect(created?.kind).toBe("dm");
    });

    it("opens the conversation with yourself when you name only yourself", async () => {
        await expect(chat.openDirect(ada, ["ada"])).resolves.toBe("new-channel");
        expect(created).toEqual({ kind: "dm", members: ["ada"] });
    });

    it("still refuses a request that names nobody", async () => {
        await expect(chat.openDirect(ada, [])).rejects.toBeInstanceOf(ChatAccessError);
        expect(created).toBeNull();
    });
});

describe("adding to a group that already exists", () => {
    it("asks only about the newcomers, and removes nobody already in it", async () => {
        // Grace is in the group but is not ada's friend - she was added before
        // the rule, or by somebody else. Adding a friend beside her still works.
        members = ["ada", "grace"];
        friends("alan");
        await chat.addChannelMembers(ada, "group-1", ["grace", "alan"]);
        expect(added).toEqual(["grace", "alan"]);
        expect(removed).toEqual([]);
    });

    it("applies to a group somebody else started, exactly as to one's own", async () => {
        members = ["grace", "ada"];
        await expect(chat.addChannelMembers(ada, "group-1", ["alan"])).resolves.toEqual({
            invited: ["alan"]
        });
        expect(invitedNow).toEqual(["alan"]);
        expect(added).toBeNull();
    });

    it("keeps a group filed under an organization to its roster, friend or not", async () => {
        groupOrgId = "org-1";
        roster = ["ada", "grace"];
        friends("alan");
        const refusal = await chat
            .addChannelMembers(ada, "group-1", ["alan"])
            .catch((caught: unknown) => caught);
        expect((refusal as InstanceType<typeof ChatAccessError>).text.key).toBe(
            "errors.notInOrganization"
        );
    });
});

describe("a one-to-one call growing into a group", () => {
    it("does not ask about the person the call was already with", async () => {
        // Grace is who ada was talking to; she is not being added by anybody.
        friends("alan");
        await expect(chat.openDirect(ada, ["grace", "alan"], "", ["ada", "grace"])).resolves.toBe(
            "new-channel"
        );
        expect(created?.members.sort()).toEqual(["ada", "alan", "grace"]);
    });

    it("still asks about whoever is being brought in", async () => {
        await expect(
            chat.openDirect(ada, ["grace", "alan"], "", ["ada", "grace"])
        ).rejects.toBeInstanceOf(reach.GroupStrangerError);
    });

    it("still refuses across a block with the person it was with", async () => {
        friends("alan");
        blocks = [{ blockerId: "grace", blockedId: "ada" }];
        await expect(
            chat.openDirect(ada, ["grace", "alan"], "", ["ada", "grace"])
        ).rejects.toBeInstanceOf(ChatAccessError);
    });
});

describe("groupStandings", () => {
    it("tells the picker apart every case it has a sentence for", async () => {
        friends("grace");
        friends("alan", "pending");
        colleagues = ["turing"];
        blocks = [{ blockerId: "linus", blockedId: "ada" }];
        const standings = await reach.groupStandings("ada", [
            "grace",
            "alan",
            "hopper",
            "turing",
            "linus",
            "ada"
        ]);
        expect(Object.fromEntries(standings)).toEqual({
            grace: "friend",
            alan: "pending",
            hopper: "stranger",
            turing: "colleague",
            linus: "blocked"
        });
    });

    it("lets an accepted friendship win over a stale request beside it", async () => {
        friends("alan", "pending", "alan");
        friends("alan");
        expect((await reach.groupStandings("ada", ["alan"])).get("alan")).toBe("friend");
    });
});

describe("the refusal, as the person who pressed the button reads it", () => {
    it("names the person and says what to do, in American English and in Spanish", () => {
        const one = new reach.GroupStrangerError("Alan", 0);
        expect(one.textIn("en-US")).toBe(
            "Alan cannot be put in a new group by you. Start the group with the others, then add them: they get an invitation instead."
        );
        expect(one.textIn("es-ES")).toBe(
            "No puedes meter a Alan en un grupo nuevo. Crea el grupo con los demás y añádelos después: recibirán una invitación."
        );
        expect(new reach.GroupStrangerError("Alan", 2).textIn("en-US")).toMatch(
            /^Alan and 2 others cannot be put in a new group by you\./
        );
        expect(new reach.GroupStrangerError("Alan", 1).textIn("es-ES")).toMatch(
            /^No puedes meter a Alan ni a otra persona en un grupo nuevo\./
        );
    });
});
