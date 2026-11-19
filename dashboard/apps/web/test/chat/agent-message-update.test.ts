/**
 * A message Polar or an app wrote, changed by it (Discord's UPDATE_MESSAGE)
 * and posted ephemerally: only the writer changes it, it is marked edited as
 * a person's edit is, and an ephemeral one leaves the room's state alone and
 * wakes only its audience.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "0190a1b2-0000-7000-8000-000000000001";

let current: { body: string; audience: string[] } | null;
const writes: { op: string; args: any }[] = [];
const frames: any[] = [];

vi.mock("@polaris/db", () => {
    const tx = {
        chatMessage: {
            create: async (args: any) => {
                writes.push({ op: "create", args });
                return { id: "new", createdAt: new Date() };
            },
            update: async (args: any) => writes.push({ op: "message.update", args }),
            updateMany: async (args: any) => {
                writes.push({ op: "updateMany", args });
                return { count: current ? 1 : 0 };
            }
        },
        chatChannel: { update: async (args: any) => writes.push({ op: "channel.update", args }) },
        chatMessageEdit: { create: async (args: any) => writes.push({ op: "edit.create", args }) }
    };
    return {
        Prisma: { DbNull: "DbNull" },
        prisma: {
            ...tx,
            chatMessage: {
                ...tx.chatMessage,
                findFirst: async (args: any) => {
                    writes.push({ op: "findFirst", args });
                    return current;
                }
            },
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
        }
    };
});
vi.mock("@/lib/chat/live", () => ({ publishChatChange: (change: unknown) => frames.push(change) }));
vi.mock("@/lib/chat/chat-lock", () => ({ unhideOnMessage: async () => writes.push({ op: "unhide", args: null }) }));
vi.mock("@/lib/chat/vanish", () => ({ expiryForChannel: async () => null }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ keepEditHistory: true }) }));

const { postAgentMessage, updateAgentMessage } = await import("@/lib/chat/agent-message");

beforeEach(() => {
    current = { body: "Before", audience: [] };
    writes.length = 0;
    frames.length = 0;
});

describe("an app's message, updated", () => {
    it("is changed only where the same app wrote it, and marked edited", async () => {
        expect(
            await updateAgentMessage({ messageId: "m1", channelId: "c1", agent: "tasks", body: "After", components: [] })
        ).toBe(true);
        const found = writes.find((write) => write.op === "findFirst")!;
        expect(found.args.where).toMatchObject({
            id: "m1",
            channelId: "c1",
            agent: "tasks",
            authorId: null,
            deletedAt: null
        });
        const changed = writes.find((write) => write.op === "updateMany")!;
        expect(changed.args.where).toMatchObject({ agent: "tasks" });
        expect(changed.args.data.editedAt).toBeInstanceOf(Date);
        expect(changed.args.data).toMatchObject({ body: "After", components: "DbNull" });
        // The earlier words kept, as a person's edit keeps them.
        expect(writes.find((write) => write.op === "edit.create")?.args.data).toMatchObject({
            messageId: "m1",
            body: "Before"
        });
        expect(frames).toEqual([{ channelId: "c1", kind: "posted", actorId: "", messageIds: ["m1"] }]);
    });

    it("is refused for a message somebody else wrote", async () => {
        current = null;
        expect(await updateAgentMessage({ messageId: "m1", channelId: "c1", agent: "tasks", body: "After" })).toBe(
            false
        );
        expect(writes.some((write) => write.op === "updateMany")).toBe(false);
        expect(frames).toEqual([]);
    });

    it("of an ephemeral message wakes only its audience", async () => {
        current = { body: "Before", audience: [ME] };
        await updateAgentMessage({ messageId: "m1", channelId: "c1", agent: "tasks", components: [] });
        expect(frames[0]).toMatchObject({ audience: [ME], messageIds: ["m1"] });
    });
});

describe("an ephemeral message, posted", () => {
    it("is stored with its audience and an expiry, and moves nothing of the room's", async () => {
        await postAgentMessage({
            channelId: "c1",
            parentId: "root",
            replyToId: "asked",
            agent: "tasks",
            label: "Tasks",
            body: "Only for you",
            audience: [ME, ME]
        });
        const created = writes.find((write) => write.op === "create")!;
        expect(created.args.data.audience).toEqual([ME]);
        expect(created.args.data.expiresAt).toBeInstanceOf(Date);
        expect(writes.map((write) => write.op)).toEqual(["create"]);
        expect(frames).toEqual([
            { channelId: "c1", kind: "posted", actorId: "", audience: [ME] }
        ]);
    });

    it("is an ordinary message without an audience", async () => {
        await postAgentMessage({
            channelId: "c1",
            parentId: null,
            replyToId: null,
            agent: "polar",
            label: "Polar",
            body: "Hi"
        });
        const created = writes.find((write) => write.op === "create")!;
        expect(created.args.data.audience).toBeUndefined();
        expect(writes.map((write) => write.op)).toEqual(["create", "channel.update", "unhide"]);
        expect(frames).toEqual([{ channelId: "c1", kind: "posted", actorId: "" }]);
    });
});
