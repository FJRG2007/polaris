/**
 * Sharing from an answer's row: the snapshot ends at that answer, on the path
 * that led to it (not the newest versions), a message from another chat is
 * ignored, updating the link without one keeps it, and sharing the whole chat
 * clears it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const THREAD = "11111111-1111-4111-8111-111111111111";

const state = {
    share: null as null | { id: string; upToMessageId: string | null; sharedAt: Date },
    writes: [] as Array<{ upToMessageId?: string | null }>
};

// q1 -> a1 (answered) and a2 (answered again, newer); a1 -> q2 -> a3.
const ROWS = [
    { id: "q1", parentId: null, role: "user", parts: [{ type: "text", text: "First" }] },
    { id: "a1", parentId: "q1", role: "assistant", parts: [{ type: "text", text: "One" }] },
    { id: "q2", parentId: "a1", role: "user", parts: [{ type: "text", text: "Second" }] },
    { id: "a3", parentId: "q2", role: "assistant", parts: [{ type: "text", text: "Three" }] },
    { id: "a2", parentId: "q1", role: "assistant", parts: [{ type: "text", text: "Two" }] }
];

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    Prisma: {},
    prisma: {
        polarThread: {
            count: async ({ where }: { where: { userId: string } }) =>
                where.userId === OWNER ? 1 : 0
        },
        polarMessage: {
            count: async ({ where }: { where: { id: string; threadId: string } }) =>
                where.threadId === THREAD && ROWS.some((row) => row.id === where.id) ? 1 : 0,
            findMany: async () => ROWS
        },
        polarThreadShare: {
            findUnique: async ({ where }: { where: { threadId?: string; tokenHash?: string } }) =>
                where.tokenHash
                    ? state.share && {
                          ...state.share,
                          threadId: THREAD,
                          linkEnabled: true,
                          thread: { title: "Chat" }
                      }
                    : state.share && { id: state.share.id },
            findFirst: async () =>
                state.share && {
                    encryptedToken: new Uint8Array(),
                    tokenNonce: new Uint8Array(),
                    tokenKeyId: "k",
                    sharedAt: state.share.sharedAt,
                    linkEnabled: true
                },
            create: async ({ data }: { data: { upToMessageId?: string | null } }) => {
                state.writes.push({ upToMessageId: data.upToMessageId });
                state.share = {
                    id: "share",
                    upToMessageId: data.upToMessageId ?? null,
                    sharedAt: new Date()
                };
            },
            update: async ({ data }: { data: { upToMessageId?: string | null } }) => {
                state.writes.push({ upToMessageId: data.upToMessageId });
                if ("upToMessageId" in data)
                    state.share = { ...state.share!, upToMessageId: data.upToMessageId ?? null };
            }
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({ ciphertext: Buffer.from("c"), nonce: Buffer.from("n"), keyId: "k" }),
    decryptSecret: () => "token-token-token-1"
}));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/privacy-service", () => ({ discoverableBy: async () => new Set() }));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set() }));
vi.mock("@/lib/notification-service", () => ({ createNotification: async () => undefined }));
vi.mock("@/lib/polar/attachments", () => ({ readThreadAttachment: async () => null }));

const share = await import("@/lib/polar/share");

beforeEach(() => {
    state.share = null;
    state.writes = [];
});

describe("pathTo", () => {
    it("walks back from the message through the versions it grew from", () => {
        expect(share.pathTo(ROWS, "a3")?.map((row) => row.id)).toEqual(["q1", "a1", "q2", "a3"]);
        expect(share.pathTo(ROWS, "a2")?.map((row) => row.id)).toEqual(["q1", "a2"]);
    });

    it("is null for a message the rows do not hold", () => {
        expect(share.pathTo(ROWS, "nope")).toBeNull();
    });
});

describe("sharing up to an answer", () => {
    it("stores the end point and the snapshot stops there", async () => {
        await share.sharePolarThread(OWNER, THREAD, "a1");
        expect(state.writes).toEqual([{ upToMessageId: "a1" }]);
        const read = await share.readSharedPolarThread("token-token-token-1");
        expect(read?.messages.map((message) => message.id)).toEqual(["q1", "a1"]);
    });

    it("an older version shared from its row is what the link shows", async () => {
        await share.sharePolarThread(OWNER, THREAD, "a3");
        const read = await share.readSharedPolarThread("token-token-token-1");
        expect(read?.messages.map((message) => message.text)).toEqual([
            "First",
            "One",
            "Second",
            "Three"
        ]);
    });

    it("ignores a message that is not this chat's", async () => {
        await share.sharePolarThread(OWNER, THREAD, "elsewhere");
        expect(state.writes).toEqual([{ upToMessageId: null }]);
    });

    it("updating the link without an end point keeps the one it had", async () => {
        await share.sharePolarThread(OWNER, THREAD, "a1");
        await share.sharePolarThread(OWNER, THREAD);
        expect(state.share?.upToMessageId).toBe("a1");
        const read = await share.readSharedPolarThread("token-token-token-1");
        expect(read?.messages.map((message) => message.id)).toEqual(["q1", "a1"]);
    });

    it("sharing the whole chat again clears the end point", async () => {
        await share.sharePolarThread(OWNER, THREAD, "a1");
        await share.sharePolarThread(OWNER, THREAD, null);
        expect(state.writes.at(-1)).toEqual({ upToMessageId: null });
        const read = await share.readSharedPolarThread("token-token-token-1");
        // The newest path: q1 then its newest answer, a2.
        expect(read?.messages.map((message) => message.id)).toEqual(["q1", "a2"]);
    });
});
