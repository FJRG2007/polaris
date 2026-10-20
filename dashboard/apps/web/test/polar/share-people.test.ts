/**
 * Polar chats sent to people: who may be named is the people search's answer,
 * checked again on the server; a recipient reads the snapshot only through their
 * own row; a link switched off is a 404; a file is read only when the snapshot
 * shows it; and continuing a chat copies its words into a chat of the reader's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const FRIEND = "00000000-0000-4000-8000-0000000000b2";
const STRANGER = "00000000-0000-4000-8000-0000000000c3";
const THREAD = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const OTHER_FILE = "44444444-4444-4444-8444-444444444444";

const state = {
    visible: new Set<string>(),
    blocked: new Set<string>(),
    barred: new Set<string>(),
    temporary: false,
    recipient: null as null | { userId: string },
    share: null as null | { linkEnabled: boolean },
    created: [] as Array<{ userId: string }>,
    messagesMade: [] as Array<{ role: string; parts: unknown }>,
    notified: [] as Array<{ userId: string; href?: string }>,
    fileReads: [] as string[],
    messageReads: 0,
    transactions: 0,
    failCopy: false
};

const SHARE = { threadId: THREAD, sharedAt: new Date(), thread: { title: "Disk", user: { name: "Ada", username: "ada" } } };
const MESSAGES = [
    {
        id: "q",
        parentId: null,
        role: "user",
        parts: [
            { type: "text", text: "Look at this" },
            { type: "file", url: `/api/polar/attachments/${FILE}`, filename: "disk.png", mediaType: "image/png" },
            { type: "file", url: "https://elsewhere.example/x.png", mediaType: "image/png" }
        ]
    },
    { id: "a", parentId: "q", role: "assistant", parts: [{ type: "text", text: "Half full." }] }
];

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    Prisma: {},
    prisma: {
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
            state.transactions += 1;
            return run((await import("@polaris/db")).prisma);
        },
        polarThread: {
            findFirst: async ({ where }: { where: { userId: string; temporary?: boolean } }) =>
                where.userId === OWNER && !(state.temporary && where.temporary === false) ? { title: "Disk" } : null,
            count: async ({ where }: { where: { userId: string; temporary?: boolean } }) =>
                where.userId === OWNER && !(state.temporary && where.temporary === false) ? 1 : 0,
            create: async () => ({ id: "new-thread" })
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id }))
        },
        polarThreadShare: {
            findUnique: async () =>
                state.share
                    ? { id: "s1", recipients: [], ...SHARE, linkEnabled: state.share.linkEnabled }
                    : null,
            create: async () => ({ id: "s1" }),
            update: async () => ({ id: "s1" })
        },
        polarShareRecipient: {
            createMany: async ({ data }: { data: Array<{ userId: string }> }) => {
                state.created.push(...data);
            },
            findMany: async () => state.created.map((row, index) => ({ id: `r${index}`, userId: row.userId, createdAt: new Date(), user: { name: "F", username: null } })),
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                state.recipient && state.recipient.userId === where.userId && where.id === ROW
                    ? { note: "see", share: SHARE }
                    : null
        },
        polarMessage: {
            findMany: async () => {
                state.messageReads += 1;
                return MESSAGES;
            },
            createMany: async ({ data }: { data: Array<{ role: string; parts: unknown }> }) => {
                if (state.failCopy) throw new Error("copy failed");
                state.messagesMade.push(...data);
            }
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({ ciphertext: Buffer.from("c"), nonce: Buffer.from("n"), keyId: "k" }),
    decryptSecret: () => "token"
}));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: unknown, ids: string[]) => new Set(ids.filter((id) => state.visible.has(id)))
}));
vi.mock("@/lib/blocks", () => ({
    blockedBetween: async (_id: string, ids: string[]) => new Set(ids.filter((id) => state.blocked.has(id)))
}));
vi.mock("@/lib/polar/access", () => ({
    polarUsersAmong: async (ids: string[]) => new Set(ids.filter((id) => !state.barred.has(id)))
}));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string; href?: string }) => void state.notified.push(input)
}));
vi.mock("@/lib/polar/attachments", () => ({
    readThreadAttachment: async (_thread: string, id: string) => {
        state.fileReads.push(id);
        return { name: "disk.png", mediaType: "image/png", size: 1, body: new ReadableStream() };
    }
}));

const share = await import("@/lib/polar/share");

beforeEach(() => {
    state.visible = new Set([FRIEND]);
    state.blocked = new Set();
    state.barred = new Set();
    state.temporary = false;
    state.recipient = null;
    state.share = null;
    state.created = [];
    state.messagesMade = [];
    state.notified = [];
    state.fileReads = [];
    state.messageReads = 0;
    state.transactions = 0;
    state.failCopy = false;
});

describe("sending a chat to people", () => {
    it("sends to somebody the search would find, and rings their bell", async () => {
        const result = await share.sendPolarShare({ id: OWNER, name: "Ada" }, THREAD, [FRIEND], "see");
        expect(result.ok).toBe(true);
        expect(state.created.map((row) => row.userId)).toEqual([FRIEND]);
        expect(state.notified).toHaveLength(1);
        expect(state.notified[0]?.userId).toBe(FRIEND);
        expect(state.notified[0]?.href).toMatch(/^\/polar\/shared\//);
    });

    it("refuses somebody hidden from the search, or blocked, without sending to anyone", async () => {
        expect(await share.sendPolarShare({ id: OWNER, name: "Ada" }, THREAD, [FRIEND, STRANGER], null)).toEqual({ ok: false, error: "unavailable" });
        state.visible.add(STRANGER);
        state.blocked.add(STRANGER);
        expect((await share.sendPolarShare({ id: OWNER, name: "Ada" }, THREAD, [STRANGER], null)).ok).toBe(false);
        expect(state.created).toEqual([]);
        expect(state.notified).toEqual([]);
    });

    it("refuses somebody barred from Polar, who could not open it", async () => {
        state.barred.add(FRIEND);
        expect(await share.sendPolarShare({ id: OWNER, name: "Ada" }, THREAD, [FRIEND], null)).toEqual({ ok: false, error: "unavailable" });
        expect(state.created).toEqual([]);
        expect(state.notified).toEqual([]);
    });

    it("never sends or links a temporary chat", async () => {
        state.temporary = true;
        expect(await share.sendPolarShare({ id: OWNER, name: "Ada" }, THREAD, [FRIEND], null)).toEqual({ ok: false, error: "not_found" });
        expect(await share.sharePolarThread(OWNER, THREAD)).toBeNull();
        expect(state.notified).toEqual([]);
    });

    it("answers a chat that is not the sender's as not found", async () => {
        expect(await share.sendPolarShare({ id: FRIEND, name: "F" }, THREAD, [OWNER], null)).toEqual({ ok: false, error: "not_found" });
    });
});

describe("reading what was sent", () => {
    it("reads only through the reader's own row", async () => {
        state.recipient = { userId: FRIEND };
        expect(await share.readReceivedPolarThread(STRANGER, ROW)).toBeNull();
        const thread = await share.readReceivedPolarThread(FRIEND, ROW);
        expect(thread?.from).toBe("Ada");
        expect(thread?.messages[0]?.files).toEqual([{ id: FILE, name: "disk.png", mediaType: "image/png" }]);
    });

    it("reads a file only when the snapshot shows it", async () => {
        state.recipient = { userId: FRIEND };
        expect(await share.readReceivedPolarFile(FRIEND, ROW, OTHER_FILE)).toBeNull();
        expect(await share.readReceivedPolarFile(STRANGER, ROW, FILE)).toBeNull();
        expect(await share.readReceivedPolarFile(FRIEND, ROW, FILE)).not.toBeNull();
        expect(state.fileReads).toEqual([FILE]);
    });

    it("reads the thread once for every file of the same snapshot", async () => {
        state.recipient = { userId: FRIEND };
        const reads = state.messageReads;
        await Promise.all([1, 2, 3].map(() => share.readReceivedPolarFile(FRIEND, ROW, FILE)));
        expect(state.messageReads - reads).toBeLessThanOrEqual(1);
        expect(state.fileReads).toEqual([FILE, FILE, FILE]);
    });

    it("leaves a missing name to the reader's language", async () => {
        state.recipient = { userId: FRIEND };
        const owner = SHARE.thread.user;
        SHARE.thread.user = { name: "", username: null as unknown as string };
        try {
            expect((await share.readReceivedPolarThread(FRIEND, ROW))?.from).toBeNull();
        } finally {
            SHARE.thread.user = owner;
        }
    });

    it("continues into a chat of the reader's, words only", async () => {
        state.recipient = { userId: FRIEND };
        expect(await share.continueReceivedPolarThread(STRANGER, ROW)).toBeNull();
        expect(await share.continueReceivedPolarThread(FRIEND, ROW)).toBe("new-thread");
        expect(state.messagesMade.map((row) => row.parts)).toEqual([
            [{ type: "text", text: "Look at this" }],
            [{ type: "text", text: "Half full." }]
        ]);
        expect(state.transactions).toBe(1);
    });

    it("copies the chat and its words in one transaction", async () => {
        state.recipient = { userId: FRIEND };
        state.failCopy = true;
        await expect(share.continueReceivedPolarThread(FRIEND, ROW)).rejects.toThrow("copy failed");
        expect(state.transactions).toBe(1);
    });
});

describe("a link that is switched off", () => {
    it("answers like one that never existed, and so do its files", async () => {
        state.share = { linkEnabled: false };
        expect(await share.readSharedPolarThread("a".repeat(43))).toBeNull();
        expect(await share.readSharedPolarFileByToken("a".repeat(43), FILE)).toBeNull();
        state.share = { linkEnabled: true };
        expect(await share.readSharedPolarThread("a".repeat(43))).not.toBeNull();
    });
});
