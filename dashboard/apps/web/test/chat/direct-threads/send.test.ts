/**
 * Threads in direct messages and groups are an administrator's switch, off by
 * default. Off refuses only STARTING one: a reply inside a thread, or under a
 * message that already has replies, still lands. A space's channels are never
 * asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MessageRow {
    id: string;
    channelId: string;
    parentId: string | null;
    replyToId: string | null;
    deletedAt: Date | null;
    authorId: string | null;
    replyCount: number;
}

let messages: MessageRow[] = [];
let created: Record<string, unknown> | null = null;
/** The conversation the send lands in. */
let shape: { kind: string; spaceId: string | null } = { kind: "dm", spaceId: null };
/** The administrator's switch, as stored. */
let switchValue: string | null = null;

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ...actual,
        requireChannel: async () => ({ channelId: "c1", mayPost: true, mayModerate: false, ...shape }),
        requirePostable: async () => ({ channelId: "c1", mayPost: true, mayModerate: false, ...shape })
    };
});
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => ({
        maxMessageLength: 4000,
        maxPerMinute: 0,
        maxAttachments: 5,
        maxAttachmentMib: 20,
        editWindowMinutes: 0,
        deleteLeavesTrace: true,
        keepEditHistory: true
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/room-mentions", () => ({
    announceRoomMention: async () => undefined,
    refuseRoomMention: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => null
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async () => true,
    maySee: async () => true,
    receiptsBetween: async () => new Map()
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        // The disappearing-messages mode, read on every send: never set here.
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                where.key === "chat.directThreads" && switchValue !== null ? { value: switchValue } : null
        },
        chatMessage: {
            // The readable check looks the message up by id.
            findFirst(args: { where: { id: string } }) {
                return this.findUnique(args);
            },
            findUnique: async ({ where }: { where: { id: string } }) =>
                messages.find((row) => row.id === where.id) ?? null,
            findMany: async () => [],
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created = data;
                return { id: "new", createdAt: new Date() };
            },
            update: async () => undefined,
            count: async () => 0
        },
        chatChannel: {
            update: async () => undefined,
            // Read by the send path for the room's own wait between messages.
            findUnique: async () => ({ slowmode: 0 }),
            // Nobody here joined too late to read: the history-visibility lookup finds no closed room.
            findMany: async () => []
        },
        chatChannelMember: { updateMany: async () => undefined, findMany: async () => [] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
                chatMessage: {
                    create: async ({ data }: { data: Record<string, unknown> }) => {
                        created = data;
                        return { id: "new", createdAt: new Date() };
                    },
                    update: async () => undefined
                },
                chatChannel: { update: async () => undefined },
                chatChannelMember: {
                    updateMany: async () => undefined,
                    upsert: async () => undefined
                }
            })
    }
}));

const { send } = await import("@/lib/chat/messages");

const actor = { id: "u1" };
const input = { channelId: "c1", body: "sure", parentId: null };

function message(id: string, replyCount = 0, parentId: string | null = null): MessageRow {
    return { id, channelId: "c1", parentId, replyToId: null, deletedAt: null, authorId: "u2", replyCount };
}

beforeEach(() => {
    created = null;
    switchValue = null;
    shape = { kind: "dm", spaceId: null };
    messages = [message("fresh"), message("busy", 2), message("inside", 0, "busy")];
});

describe("starting a thread in a direct message or group", () => {
    for (const kind of ["dm", "group"]) {
        it(`is refused in a ${kind} while the switch is unset`, async () => {
            shape = { kind, spaceId: null };
            await expect(send(actor, { ...input, parentId: "fresh" }, [])).rejects.toThrow(
                "Threads are off in direct messages and groups here"
            );
            expect(created).toBeNull();
        });

        it(`lands in a ${kind} once an administrator turns it on`, async () => {
            shape = { kind, spaceId: null };
            switchValue = "on";
            await send(actor, { ...input, parentId: "fresh" }, []);
            expect(created?.parentId).toBe("fresh");
        });
    }

    it("is refused again once the switch is turned back off", async () => {
        switchValue = "off";
        await expect(send(actor, { ...input, parentId: "fresh" }, [])).rejects.toThrow(/Threads are off/);
    });
});

describe("a thread that already exists, with the switch off", () => {
    it("still takes a reply under its root", async () => {
        await send(actor, { ...input, parentId: "busy" }, []);
        expect(created?.parentId).toBe("busy");
    });

    it("still takes a reply to a reply, filed under the root", async () => {
        await send(actor, { ...input, parentId: "inside" }, []);
        expect(created?.parentId).toBe("busy");
    });
});

describe("a channel in a space", () => {
    it("starts a thread whatever the switch says", async () => {
        shape = { kind: "text", spaceId: "s1" };
        await send(actor, { ...input, parentId: "fresh" }, []);
        expect(created?.parentId).toBe("fresh");
    });
});
