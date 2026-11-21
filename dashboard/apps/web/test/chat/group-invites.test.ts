/**
 * Group invitations (ledger row 16): somebody whose "who can add me to groups"
 * refuses an add is asked instead, and accepting re-checks the room.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Invite = {
    id: string;
    channelId: string;
    inviterId: string;
    inviteeId: string;
    createdAt: Date;
    acceptedAt: Date | null;
    declinedAt: Date | null;
};

let invites: Invite[] = [];
let members: string[] = [];
let blocked = new Set<string>();
let group: { kind: string; archived: boolean; name: string } | null = null;
let notified: string[] = [];
let joined: string[] = [];

vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => blocked }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async ({ userId }: { userId: string }) => {
        notified.push(userId);
        return { inapp: "created" };
    }
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({ postNotice: async () => undefined }));
vi.mock("@/lib/chat/text", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    chatWordsFor: async () => (key: string) => key
}));
vi.mock("@polaris/db", () => {
    const find = (where: { channelId_inviteeId: { channelId: string; inviteeId: string } }) =>
        invites.find(
            (row) =>
                row.channelId === where.channelId_inviteeId.channelId &&
                row.inviteeId === where.channelId_inviteeId.inviteeId
        );
    return {
        prisma: {
            chatGroupInvite: {
                findMany: async ({ where }: { where: { channelId: string; inviteeId: { in: string[] } } }) =>
                    invites.filter(
                        (row) =>
                            row.channelId === where.channelId &&
                            where.inviteeId.in.includes(row.inviteeId)
                    ),
                findUnique: async ({ where }: { where: { id: string } }) =>
                    invites.find((row) => row.id === where.id) ?? null,
                upsert: ({ where, create, update }: {
                    where: { channelId_inviteeId: { channelId: string; inviteeId: string } };
                    create: Omit<Invite, "id" | "createdAt" | "acceptedAt" | "declinedAt">;
                    update: Partial<Invite>;
                }) => {
                    const row = find(where);
                    if (row) Object.assign(row, update);
                    else
                        invites.push({
                            ...create,
                            id: `invite-${invites.length + 1}`,
                            createdAt: new Date(),
                            acceptedAt: null,
                            declinedAt: null
                        });
                    return Promise.resolve();
                },
                update: ({ where, data }: { where: { id: string }; data: Partial<Invite> }) => {
                    Object.assign(invites.find((row) => row.id === where.id)!, data);
                    return Promise.resolve();
                }
            },
            chatChannel: { findUnique: async () => group },
            chatChannelMember: {
                findUnique: async ({ where }: { where: { channelId_userId: { userId: string } } }) =>
                    members.includes(where.channelId_userId.userId) ? { userId: "x" } : null,
                count: async () => members.length,
                createMany: ({ data }: { data: { userId: string }[] }) => {
                    joined.push(...data.map((row) => row.userId));
                    return Promise.resolve();
                }
            },
            user: { findUnique: async () => ({ name: "Ada" }) },
            $transaction: async (ops: unknown[]) => Promise.all(ops)
        }
    };
});

const invitesModule = await import("@/lib/chat/group-invites");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };
const alan = { id: "alan" };

beforeEach(() => {
    invites = [];
    members = ["ada", "grace"];
    blocked = new Set();
    group = { kind: "group", archived: false, name: "Team" };
    notified = [];
    joined = [];
});

describe("asking instead of adding", () => {
    it("writes one pending invitation and notifies once, however often it is repeated", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        expect(invites).toHaveLength(1);
        expect(notified).toEqual(["alan"]);
    });

    it("lets a recent decline stand", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        await invitesModule.declineGroupInvite(alan, invites[0]!.id);
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        expect(invites[0]!.declinedAt).not.toBeNull();
        expect(notified).toEqual(["alan"]);
    });
});

describe("answering", () => {
    it("joins the group on accept", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        await expect(invitesModule.acceptGroupInvite(alan, invites[0]!.id)).resolves.toBe("g1");
        expect(joined).toEqual(["alan"]);
        expect(invites[0]!.acceptedAt).not.toBeNull();
    });

    it("refuses somebody else's invitation as if it did not exist", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        await expect(
            invitesModule.acceptGroupInvite({ id: "mallory" }, invites[0]!.id)
        ).rejects.toBeInstanceOf(ChatAccessError);
        expect(joined).toEqual([]);
    });

    it("closes the invitation when whoever asked has left or a block stands", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        members = ["grace"];
        await expect(invitesModule.acceptGroupInvite(alan, invites[0]!.id)).rejects.toBeInstanceOf(
            ChatAccessError
        );
        expect(joined).toEqual([]);
        expect(invites[0]!.declinedAt).not.toBeNull();
    });

    it("refuses a group that has gone", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        group = null;
        await expect(invitesModule.acceptGroupInvite(alan, invites[0]!.id)).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });
});
