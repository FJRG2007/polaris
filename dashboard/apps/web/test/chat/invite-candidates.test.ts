/**
 * Who the invite dialog lists with nothing typed, and what a card under a
 * message says about a link that no longer opens.
 *
 * The friends list offers only friends a direct message reaches, and fills
 * with people still outside the space before members take any room. A dead
 * link's card carries nothing about the space it named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "0193b0f0-0000-7000-8000-0000000000aa";

interface Person {
    id: string;
    name: string;
    username: string | null;
}

let friends: string[] = [];
let people: Person[] = [];
let memberIds: string[] = [];
let unreachable = new Set<string>();
let inviteRows: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async ({ where, take }: { where: { id: { in: string[] } }; take: number }) =>
                people
                    .filter((person) => where.id.in.includes(person.id))
                    .sort((one, other) => one.name.localeCompare(other.name))
                    .slice(0, take)
        },
        chatSpaceMember: {
            findMany: async () => memberIds.map((userId) => ({ userId, spaceId: SPACE })),
            groupBy: async () => [{ spaceId: SPACE, _count: { _all: 4 } }]
        },
        chatSpace: { findUnique: async () => ({ ownerId: "owner" }) },
        chatSpaceInvite: { findMany: async () => inviteRows }
    }
}));

vi.mock("@/lib/chat/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/chat/access")>()),
    spaceAccess: async () => "member",
    searchForConversation: async () => ({ people: [], withheld: 0 }),
    directReachable: async (_actor: unknown, ids: readonly string[]) =>
        new Set(ids.filter((id) => !unreachable.has(id)))
}));
vi.mock("@/lib/chat/chat-service", () => ({ openDirect: async () => "dm-1" }));
vi.mock("@/lib/chat/messages", () => ({ send: async () => "m1" }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set(friends) }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({ postSpaceNotice: async () => undefined }));

const { inviteCandidates } = await import("@/lib/chat/invites");
const { inviteCards } = await import("@/lib/chat/invite-cards");

const ada = { id: "ada" };

function person(id: string): Person {
    return { id, name: id, username: null };
}

beforeEach(() => {
    friends = [];
    people = [];
    memberIds = [];
    unreachable = new Set();
    inviteRows = [];
});

describe("the invite dialog's friends list", () => {
    it("leaves out a friend a direct message cannot reach", async () => {
        friends = ["bea", "cal"];
        people = friends.map(person);
        unreachable = new Set(["cal"]);
        const listed = await inviteCandidates(ada, SPACE, "");
        expect(listed.map((one) => one.id)).toEqual(["bea"]);
    });

    it("fills with friends outside the space before members take any room", async () => {
        const inside = Array.from({ length: 120 }, (_, index) => `a-member-${index}`);
        const outside = ["z-outside-1", "z-outside-2"];
        friends = [...inside, ...outside];
        people = friends.map(person);
        memberIds = inside;
        const listed = await inviteCandidates(ada, SPACE, "");
        expect(listed).toHaveLength(100);
        expect(listed.slice(0, 2).map((one) => [one.id, one.member])).toEqual([
            ["z-outside-1", false],
            ["z-outside-2", false]
        ]);
        expect(listed.slice(2).every((one) => one.member)).toBe(true);
    });
});

describe("an invite card for a link that no longer opens", () => {
    it("says nothing about the space", async () => {
        inviteRows = [
            {
                code: "Revoked123",
                expiresAt: null,
                maxUses: null,
                uses: 0,
                revokedAt: new Date(),
                channelId: null,
                channel: null,
                space: {
                    id: SPACE,
                    name: "Secret",
                    color: "#123456",
                    archived: false,
                    ownerId: "owner"
                }
            }
        ];
        const card = (await inviteCards(ada, ["Revoked123"])).get("Revoked123");
        expect(card).toEqual({
            code: "Revoked123",
            spaceId: null,
            spaceName: "",
            spaceColor: "",
            channelId: null,
            usable: false,
            member: false,
            members: 0,
            online: 0
        });
    });
});
