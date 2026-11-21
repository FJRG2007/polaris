/**
 * Message requests (ledger row 17): somebody outside "who can message me"
 * lands in requests instead of being refused, and answering one accepts,
 * deletes or blocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; channelId: string; userId: string; requestedAt: Date | null; muted: boolean };

let rows: Row[] = [];
let allowed = new Set<string>();
let colleagues = new Set<string>();
let blocked = new Set<string>();
let blockedBy: [string, string][] = [];
let blockFails = false;
let detached: string[] = [];

class FakeBlockError extends Error {}

vi.mock("@/lib/blocks", () => ({
    BlockError: FakeBlockError,
    blockedBetween: async () => blocked,
    block: async (userId: string, otherId: string) => {
        if (blockFails) throw new FakeBlockError("list is full");
        blockedBy.push([userId, otherId]);
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    colleaguesAmong: async () => colleagues,
    allowedBy: async (
        _viewer: unknown,
        field: string,
        ids: string[],
        asFriends?: ReadonlySet<string>
    ) => {
        expect(field).toBe("messages");
        return new Set(ids.filter((id) => allowed.has(id) || asFriends?.has(id)));
    }
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@polaris/db", () => {
    const pending = (where: { userId: string; channelId?: string }) =>
        rows.find(
            (row) =>
                row.userId === where.userId &&
                row.requestedAt !== null &&
                (where.channelId === undefined || row.channelId === where.channelId)
        );
    return {
        prisma: {
            chatChannelMember: {
                findFirst: async ({ where }: { where: { userId: string; channelId: string } }) => {
                    const row = pending(where);
                    if (!row) return null;
                    return {
                        id: row.id,
                        channel: {
                            members: rows
                                .filter((other) => other.channelId === row.channelId)
                                .map((other) => ({ userId: other.userId }))
                        }
                    };
                },
                update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                    Object.assign(rows.find((row) => row.id === where.id)!, data);
                },
                delete: ({ where }: { where: { id: string } }) => {
                    rows = rows.filter((row) => row.id !== where.id);
                    return Promise.resolve();
                },
                count: async ({ where }: { where: { userId: string } }) =>
                    rows.filter((row) => row.userId === where.userId && row.requestedAt).length
            },
            chatChannel: {
                update: ({ where }: { where: { id: string } }) => {
                    detached.push(where.id);
                    return Promise.resolve();
                }
            },
            $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes)
        }
    };
});

const requests = await import("@/lib/chat/message-requests");
const { ChatAccessError } = await import("@/lib/chat/access");

const ana = { id: "ana" };

beforeEach(() => {
    rows = [
        { id: "m1", channelId: "c1", userId: "ana", requestedAt: new Date(), muted: true },
        { id: "m2", channelId: "c1", userId: "bob", requestedAt: null, muted: false }
    ];
    allowed = new Set();
    colleagues = new Set();
    blocked = new Set();
    blockedBy = [];
    blockFails = false;
    detached = [];
});

describe("landsInRequests", () => {
    it("holds a sender the recipient's setting leaves out", async () => {
        expect(await requests.landsInRequests("bob", "ana")).toBe(true);
    });

    it("lets in anybody the setting allows, and colleagues where it says friends", async () => {
        allowed = new Set(["ana"]);
        expect(await requests.landsInRequests("bob", "ana")).toBe(false);
        allowed = new Set();
        colleagues = new Set(["ana"]);
        expect(await requests.landsInRequests("bob", "ana")).toBe(false);
    });

    it("never holds a conversation with yourself", async () => {
        expect(await requests.landsInRequests("ana", "ana")).toBe(false);
    });
});

describe("answering a request", () => {
    it("accepting unmutes it and puts it on the rail", async () => {
        expect(await requests.acceptMessageRequest(ana, "c1")).toBe("c1");
        expect(rows[0]).toMatchObject({ requestedAt: null, muted: false });
    });

    it("accepting refuses once either side has blocked the other", async () => {
        blocked = new Set(["bob"]);
        await expect(requests.acceptMessageRequest(ana, "c1")).rejects.toBeInstanceOf(ChatAccessError);
        expect(rows[0]!.requestedAt).not.toBeNull();
    });

    it("deleting leaves the conversation and frees its one-to-one key", async () => {
        await requests.declineMessageRequest(ana, "c1", false);
        expect(rows.map((row) => row.userId)).toEqual(["bob"]);
        expect(detached).toEqual(["c1"]);
        expect(blockedBy).toEqual([]);
    });

    it("blocking blocks the sender as well", async () => {
        await requests.declineMessageRequest(ana, "c1", true);
        expect(blockedBy).toEqual([["ana", "bob"]]);
    });

    it("a block that fails is one translated refusal and leaves the request", async () => {
        blockFails = true;
        await expect(requests.declineMessageRequest(ana, "c1", true)).rejects.toBeInstanceOf(
            ChatAccessError
        );
        expect(rows).toHaveLength(2);
    });

    it("a request that is not waiting is refused, never answered", async () => {
        await expect(requests.acceptMessageRequest({ id: "bob" }, "c1")).rejects.toBeInstanceOf(
            ChatAccessError
        );
        await expect(requests.declineMessageRequest(ana, "other", false)).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });
});
