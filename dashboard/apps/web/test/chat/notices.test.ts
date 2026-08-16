/**
 * The lines Polaris writes into a conversation when somebody comes or goes.
 *
 * Two halves worth pinning. The wording and the mention round-trip, because a
 * notice that lost its reference would be a sentence with a name frozen in it.
 * And who gets one at all: leaving quietly has to mean nothing is written, and
 * that must be a decision only the person leaving can make - an administrator
 * removing somebody cannot also silence the room about it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "0193aaaa-0000-7000-8000-000000000001";
const GRACE = "0193aaaa-0000-7000-8000-000000000002";

let kind = "group";
let members = [ADA, GRACE];
/** Every system message written during a test. */
let written: { channelId: string; body: string }[] = [];

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@polaris/auth", () => ({ can: async () => true }));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: null,
                kind,
                private: true,
                archived: false,
                space: null,
                ownerId: ADA,
                membersMayEdit: false
            }),
            findFirst: async () => ({ id: "channel-1" }),
            update: async () => ({})
        },
        chatChannelMember: {
            findFirst: async () => ({ userId: members[0] ?? null }),
            findUnique: async ({ where }: { where: { channelId_userId: { userId: string } } }) =>
                members.includes(where.channelId_userId.userId) ? { role: "member" } : null,
            findMany: async ({ where }: { where: { userId?: { in: string[] } } }) =>
                members
                    .filter((id) => where.userId?.in?.includes(id) ?? true)
                    .map((userId) => ({ userId })),
            count: async ({ where }: { where?: { userId?: { in: string[] } } }) =>
                where?.userId?.in
                    ? members.filter((id) => where.userId!.in.includes(id)).length
                    : members.length,
            createMany: async ({ data }: { data: { userId: string }[] }) => ({ count: data.length }),
            deleteMany: async () => ({ count: 1 })
        },
        chatMessage: {
            create: async ({ data }: { data: { channelId: string; body: string } }) => {
                written.push({ channelId: data.channelId, body: data.body });
                return { id: "message-1" };
            }
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: id === ADA ? "Ada" : "Grace" }))
        },
        chatSpace: { findMany: async () => [] }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const { noticeBody, noticePeople, renderNotice } = await import("@/lib/chat/notice-text");

const ada = { id: ADA };
const grace = { id: GRACE };

beforeEach(() => {
    kind = "group";
    members = [ADA, GRACE];
    written = [];
});

describe("how a notice reads", () => {
    it("names the person and, when there is one, who did it", () => {
        const person = { id: ADA, name: "Ada" };
        const by = { id: GRACE, name: "Grace" };
        expect(renderNotice(noticeBody("joined", person), new Map())).toBe("Ada joined");
        expect(renderNotice(noticeBody("left", person), new Map())).toBe("Ada left");
        expect(renderNotice(noticeBody("added", person, by), new Map())).toBe("Grace added Ada");
        expect(renderNotice(noticeBody("removed", person, by), new Map())).toBe(
            "Grace removed Ada"
        );
    });

    it("does not say somebody added themselves", () => {
        const person = { id: ADA, name: "Ada" };
        expect(renderNotice(noticeBody("added", person, person), new Map())).toBe("Ada was added");
    });

    it("keeps the accounts it names, so the name can be resolved again", () => {
        const body = noticeBody("added", { id: ADA, name: "Ada" }, { id: GRACE, name: "Grace" });
        expect(noticePeople(body).sort()).toEqual([ADA, GRACE].sort());
        // Renamed since. The line follows rather than quoting last year's name.
        expect(renderNotice(body, new Map([[ADA, "Ada Lovelace"]]))).toBe(
            "Grace added Ada Lovelace"
        );
    });

    it("calls the person reading it you, in the right case", () => {
        const body = noticeBody("added", { id: GRACE, name: "Grace" }, { id: ADA, name: "Ada" });
        expect(renderNotice(body, new Map(), ADA)).toBe("You added Grace");
        expect(renderNotice(body, new Map(), GRACE)).toBe("Ada added you");
        // Somebody who is in neither role reads both names.
        expect(renderNotice(body, new Map(), "0193aaaa-0000-7000-8000-00000000009f")).toBe(
            "Ada added Grace"
        );
        expect(renderNotice(noticeBody("left", { id: ADA, name: "Ada" }), new Map(), ADA)).toBe(
            "You left"
        );
    });

    it("falls back to the name written at the time", () => {
        const body = noticeBody("joined", { id: ADA, name: "Ada" });
        expect(renderNotice(body, new Map())).toBe("Ada joined");
    });

    it("resolves an account whose id is not a uuid", () => {
        // Accounts made before ids became uuids still carry the old shape. A
        // pattern that only knew uuids left the raw `[Name](polaris:user/...)`
        // on screen, which is how this was found.
        const legacy = "giTI1qvpjBkRgzOj0wdcjMo70PJljQ1D";
        const body = noticeBody("left", { id: legacy, name: "Verify Admin" });
        expect(noticePeople(body)).toEqual([legacy.toLowerCase()]);
        expect(renderNotice(body, new Map([[legacy.toLowerCase(), "Verify Admin"]]))).toBe(
            "Verify Admin left"
        );
        expect(renderNotice(body, new Map(), legacy)).toBe("You left");
    });

    it("never leaves markup on screen for somebody it cannot find", () => {
        const body = noticeBody("joined", { id: "who-knows", name: "Someone" });
        expect(renderNotice(body, new Map())).toBe("Someone joined");
    });

    it("survives a name with brackets in it", () => {
        const body = noticeBody("joined", { id: ADA, name: "Ada [admin]" });
        expect(noticePeople(body)).toEqual([ADA]);
        expect(renderNotice(body, new Map())).toBe("Ada admin joined");
    });
});

describe("a group", () => {
    it("says so when somebody is added", async () => {
        members = [ADA];
        await chat.addChannelMembers(ada, "channel-1", [GRACE]);
        expect(written).toHaveLength(1);
        expect(renderNotice(written[0]!.body, new Map())).toBe("Ada added Grace");
    });

    it("says nothing about somebody who was already in it", async () => {
        await chat.addChannelMembers(ada, "channel-1", [GRACE]);
        expect(written).toEqual([]);
    });

    it("says so when somebody leaves", async () => {
        await chat.removeChannelMember(grace, "channel-1", GRACE);
        expect(renderNotice(written[0]?.body ?? "", new Map())).toBe("Grace left");
    });

    it("says nothing when they asked to leave quietly", async () => {
        await chat.removeChannelMember(grace, "channel-1", GRACE, true);
        expect(written).toEqual([]);
    });
});

describe("a direct message", () => {
    it("has no notices in it at all", async () => {
        kind = "dm";
        // Nobody joins or leaves a one-to-one conversation; adding a third
        // person makes a group, which is a different room.
        await expect(chat.removeChannelMember(grace, "channel-1", GRACE)).rejects.toThrow();
        expect(written).toEqual([]);
    });
});
