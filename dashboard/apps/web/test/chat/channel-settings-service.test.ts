/**
 * What a channel's settings page saves, checked where it is enforced.
 *
 * - The age gate: an age-restricted channel refuses its messages to anybody who
 *   has not confirmed, and confirming is remembered once per person.
 * - Invite links that open on one channel: only a public, open channel of the
 *   same space; accepting lands on it, unless it has gone private since.
 * - Making a channel private keeps whoever closed it inside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    channel: null as null | Record<string, unknown>,
    confirmations: [] as Array<{ channelId: string; userId: string }>,
    invites: [] as Array<Record<string, unknown>>,
    standing: "admin" as string | null,
    channelUpdates: [] as Array<Record<string, unknown>>,
    memberUpserts: [] as Array<Record<string, unknown>>,
    access: { spaceId: "s1", mayAdminister: true, kind: "text" } as Record<string, unknown>
}));

vi.mock("@polaris/db", () => {
    const tx = {
        chatChannel: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
                db.channelUpdates.push(data);
                return {};
            }
        },
        chatChannelMember: {
            upsert: async (args: Record<string, unknown>) => {
                db.memberUpserts.push(args);
                return {};
            }
        }
    };
    return {
        prisma: {
            chatChannel: {
                findUnique: async ({ select }: { select: Record<string, unknown> }) => {
                    if (!db.channel) return null;
                    if ("ageConfirmations" in select) {
                        return {
                            ...db.channel,
                            ageConfirmations: db.confirmations
                                .filter((row) => row.channelId === db.channel!.id)
                                .map(() => ({ id: "x" }))
                        };
                    }
                    return db.channel;
                }
            },
            chatAgeConfirmation: {
                upsert: async ({ create }: { create: { channelId: string; userId: string } }) => {
                    if (
                        !db.confirmations.some(
                            (row) => row.channelId === create.channelId && row.userId === create.userId
                        )
                    ) {
                        db.confirmations.push(create);
                    }
                    return {};
                }
            },
            chatSpace: {
                findUnique: async () => ({ id: "s1", visibility: "internal", archived: false })
            },
            chatSpaceInvite: {
                create: async ({ data }: { data: Record<string, unknown> }) => {
                    const row = {
                        id: `i${db.invites.length + 1}`,
                        code: "abcdefgh",
                        uses: 0,
                        revokedAt: null,
                        createdAt: new Date(),
                        createdBy: { name: "Ada" },
                        ...data
                    };
                    db.invites.push(row);
                    return row;
                },
                findUnique: async () => db.invites[0] ?? null,
                updateMany: async () => ({ count: 1 })
            },
            chatSpaceMember: {
                findUnique: async () => null,
                create: async () => ({})
            },
            chatSpaceBan: { findUnique: async () => null },
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
        }
    };
});

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ...actual,
        spaceAccess: async () => db.standing,
        requireChannel: async () => db.access
    };
});

vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postSpaceNotice: async () => undefined,
    postNotice: async () => undefined
}));

const gate = await import("@/lib/chat/age-gate");
const invites = await import("@/lib/chat/invites");

const ME = { id: "u1" };
const SPACE = "0190a000-0000-7000-8000-00000000000a";
const CHANNEL = "0190a000-0000-7000-8000-0000000000c1";

beforeEach(() => {
    db.channel = { id: CHANNEL, spaceId: SPACE, contentMode: "age", private: false, archived: false };
    db.confirmations = [];
    db.invites = [];
    db.standing = "admin";
    db.channelUpdates = [];
    db.memberUpserts = [];
    db.access = { spaceId: SPACE, mayAdminister: true, kind: "text" };
});

describe("the age gate", () => {
    it("is shut until confirmed, and open after, once", async () => {
        expect(await gate.ageGateClosed(ME.id, CHANNEL)).toBe(true);
        await expect(gate.requireAgeCleared(ME, CHANNEL)).rejects.toThrow();
        await gate.confirmAge(ME, CHANNEL);
        await gate.confirmAge(ME, CHANNEL);
        expect(db.confirmations).toHaveLength(1);
        expect(await gate.ageGateClosed(ME.id, CHANNEL)).toBe(false);
        await expect(gate.requireAgeCleared(ME, CHANNEL)).resolves.toBeUndefined();
    });

    it("is not there on an ordinary channel, a spoiler one, or a conversation outside a space", async () => {
        db.channel = { ...db.channel, contentMode: "default" };
        expect(await gate.ageGateClosed(ME.id, CHANNEL)).toBe(false);
        db.channel = { ...db.channel, contentMode: "spoiler" };
        expect(await gate.ageGateClosed(ME.id, CHANNEL)).toBe(false);
        db.channel = { ...db.channel, contentMode: "age", spaceId: null };
        expect(await gate.ageGateClosed(ME.id, CHANNEL)).toBe(false);
    });

    it("leaves age-restricted channels out of a search until confirmed", () => {
        expect(gate.ageClearedWhere(ME.id)).toEqual({
            channel: {
                OR: [
                    { contentMode: { not: "age" } },
                    { spaceId: null },
                    { ageConfirmations: { some: { userId: ME.id } } }
                ]
            }
        });
    });
});

describe("a link that opens on a channel", () => {
    const input = { spaceId: SPACE, channelId: CHANNEL, expiresMinutes: 1440, maxUses: 0 };

    it("is made for a public, open channel of the same space", async () => {
        db.channel = { spaceId: SPACE, private: false, archived: false };
        const made = await invites.createInvite(ME, input);
        expect(made.channelId).toBe(CHANNEL);
        expect(made.createdBy).toBe("Ada");
    });

    it("is refused for a private channel, an archived one, or one in another space", async () => {
        for (const channel of [
            { spaceId: SPACE, private: true, archived: false },
            { spaceId: SPACE, private: false, archived: true },
            { spaceId: "another", private: false, archived: false }
        ]) {
            db.channel = channel;
            await expect(invites.createInvite(ME, input)).rejects.toThrow();
        }
        expect(db.invites).toEqual([]);
    });

    it("can be made by the space's owner, who has no membership row", async () => {
        db.channel = { spaceId: SPACE, private: false, archived: false };
        db.standing = "owner";
        await expect(invites.createInvite(ME, input)).resolves.toBeTruthy();
        db.standing = null;
        await expect(invites.createInvite(ME, input)).rejects.toThrow();
    });

    it("lands on the channel when accepted, and on the space once it has gone private", async () => {
        db.invites = [
            {
                id: "i1",
                spaceId: SPACE,
                channelId: CHANNEL,
                channel: { private: false },
                expiresAt: null,
                maxUses: null,
                uses: 0,
                revokedAt: null,
                space: { archived: false }
            }
        ];
        expect(await invites.acceptInvite(ME, "abcdefgh")).toEqual({ spaceId: SPACE, channelId: CHANNEL });
        db.invites[0] = { ...db.invites[0], channel: { private: true } };
        expect(await invites.acceptInvite(ME, "abcdefgh")).toEqual({ spaceId: SPACE, channelId: null });
    });
});

describe("saving the settings", () => {
    it("keeps whoever makes a channel private inside it, as its administrator", async () => {
        const chat = await import("@/lib/chat/chat-service");
        await chat.updateChannel(ME, { channelId: CHANNEL, private: true, contentMode: "spoiler" });
        expect(db.channelUpdates[0]).toEqual({ private: true, contentMode: "spoiler" });
        expect(db.memberUpserts[0]).toMatchObject({
            create: { channelId: CHANNEL, userId: ME.id, role: "admin" },
            update: { role: "admin" }
        });
    });

    it("writes no membership when opening a channel up", async () => {
        const chat = await import("@/lib/chat/chat-service");
        await chat.updateChannel(ME, { channelId: CHANNEL, private: false });
        expect(db.memberUpserts).toEqual([]);
    });

    it("is refused somebody who does not run the channel", async () => {
        const chat = await import("@/lib/chat/chat-service");
        db.access = { spaceId: SPACE, mayAdminister: false, kind: "text" };
        await expect(
            chat.updateChannel(ME, { channelId: CHANNEL, contentMode: "age" })
        ).rejects.toThrow();
        expect(db.channelUpdates).toEqual([]);
    });

    it("takes only the content modes it knows, and Discord's slowmode steps", async () => {
        const core = await import("@polaris/core");
        const parse = (input: Record<string, unknown>) =>
            core.chatChannelUpdateSchema.safeParse({ channelId: CHANNEL, ...input }).success;
        expect(parse({ contentMode: "age" })).toBe(true);
        expect(parse({ contentMode: "nsfw" })).toBe(false);
        for (const seconds of [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]) {
            expect(parse({ slowmode: seconds })).toBe(true);
        }
        expect(parse({ slowmode: 45 })).toBe(false);
        expect(parse({ topic: "x".repeat(core.MAX_CHANNEL_TOPIC) })).toBe(true);
        expect(parse({ topic: "x".repeat(core.MAX_CHANNEL_TOPIC + 1) })).toBe(false);
    });
});
