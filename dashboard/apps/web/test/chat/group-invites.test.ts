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
    cardPostedAt?: Date | null;
};

let invites: Invite[] = [];
let members: string[] = [];
let blocked = new Set<string>();
let group: { kind: string; archived: boolean; name: string } | null = null;
let notified: string[] = [];
let joined: string[] = [];
let notifiedHref: string[] = [];
let sent: { channelId: string; authorId: string; body: string }[] = [];
let refuseDirect = false;
let requested = new Set<string>();

vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => blocked }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async ({ userId, href }: { userId: string; href: string }) => {
        notified.push(userId);
        notifiedHref.push(href);
        return { inapp: "created" };
    }
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example/" }));
vi.mock("@/lib/chat/chat-service", async () => {
    const { ChatAccessError } = await import("@/lib/chat/access");
    return {
        openDirect: async (actor: { id: string }, ids: string[]) => {
            if (refuseDirect) throw new ChatAccessError({ key: "errors.blocked" });
            return `dm-${actor.id}-${ids[0]}`;
        }
    };
});
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string }) => {
        sent.push({ channelId: input.channelId, authorId: actor.id, body: input.body });
        return "m1";
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
                findMany: async ({
                    where
                }: {
                    where: { channelId?: string; inviteeId: string | { in: string[] }; cardPostedAt?: null };
                }) =>
                    typeof where.inviteeId === "string"
                        ? invites.filter(
                              (row) =>
                                  row.inviteeId === where.inviteeId &&
                                  !row.acceptedAt &&
                                  !row.declinedAt &&
                                  !row.cardPostedAt
                          )
                        : invites.filter(
                              (row) =>
                                  row.channelId === where.channelId &&
                                  (where.inviteeId as { in: string[] }).in.includes(row.inviteeId)
                          ),
                updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Invite> }) => {
                    const row = invites.find(
                        (entry) =>
                            entry.id === where.id &&
                            !entry.cardPostedAt &&
                            !entry.acceptedAt &&
                            !entry.declinedAt
                    );
                    if (row) Object.assign(row, data);
                    return { count: row ? 1 : 0 };
                },
                findUnique: async ({ where }: { where: { id: string } }) =>
                    invites.find((row) => row.id === where.id) ?? null,
                upsert: ({ where, create, update }: {
                    where: { channelId_inviteeId: { channelId: string; inviteeId: string } };
                    create: Omit<Invite, "id" | "createdAt" | "acceptedAt" | "declinedAt">;
                    update: Partial<Invite>;
                }) => {
                    let row = find(where);
                    if (row) Object.assign(row, update);
                    else {
                        row = {
                            ...create,
                            id: `invite-${invites.length + 1}`,
                            createdAt: new Date(),
                            acceptedAt: null,
                            declinedAt: null,
                            cardPostedAt: null
                        };
                        invites.push(row);
                    }
                    return Promise.resolve({ ...row });
                },
                update: ({ where, data }: { where: { id: string }; data: Partial<Invite> }) => {
                    Object.assign(invites.find((row) => row.id === where.id)!, data);
                    return Promise.resolve();
                }
            },
            chatChannel: { findUnique: async () => group },
            chatChannelMember: {
                findUnique: async ({
                    where,
                    select
                }: {
                    where: { channelId_userId: { channelId: string; userId: string } };
                    select: Record<string, boolean>;
                }) =>
                    select.requestedAt
                        ? {
                              requestedAt: requested.has(where.channelId_userId.userId)
                                  ? new Date()
                                  : null
                          }
                        : members.includes(where.channelId_userId.userId)
                          ? { userId: "x" }
                          : null,
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
    notifiedHref = [];
    sent = [];
    refuseDirect = false;
    requested = new Set();
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

describe("the card in the direct message", () => {
    it("posts the invitation as the inviter, into their conversation, once", async () => {
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        expect(sent).toEqual([
            {
                channelId: "dm-ada-alan",
                authorId: "ada",
                body: `https://polaris.example/chat/invites?g=${invites[0]!.id}`
            }
        ]);
        expect(notifiedHref).toEqual(["/chat/c/dm-ada-alan"]);
    });

    it("leads to the requests when the conversation is held as one", async () => {
        requested.add("alan");
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        expect(notifiedHref).toEqual(["/chat/requests"]);
    });

    it("falls back to the invitations page when no conversation may be opened", async () => {
        refuseDirect = true;
        await invitesModule.inviteToGroup(ada, "g1", ["alan"]);
        expect(sent).toEqual([]);
        expect(notifiedHref).toEqual(["/chat/invites"]);
        // Tried once: the next pass does not ask again.
        refuseDirect = false;
        await invitesModule.postWaitingInviteCards(alan);
        expect(sent).toEqual([]);
    });

    it("gives an invitation from before the card its card once, and rings nobody", async () => {
        invites.push({
            id: "old-1",
            channelId: "g1",
            inviterId: "ada",
            inviteeId: "alan",
            createdAt: new Date(),
            acceptedAt: null,
            declinedAt: null,
            cardPostedAt: null
        });
        await invitesModule.postWaitingInviteCards(alan);
        await invitesModule.postWaitingInviteCards(alan);
        expect(sent.map((one) => one.body)).toEqual(["https://polaris.example/chat/invites?g=old-1"]);
        expect(notified).toEqual([]);
    });
});
