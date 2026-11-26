/**
 * Sealed scheduled messages (docs/chat-e2ee-mls.md, "Sealed scheduled
 * messages"): sealed in the writer's browser at the conversation's current
 * epoch, kept by the server as a seal and nothing else, and sent only while the
 * conversation is still at that epoch - after a rekey the writer's device seals
 * it again, and until it does the row is set aside with a reason.
 */

import { chatText, type ChatText } from "@/lib/chat/text";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    channelId: string;
    authorId: string;
    body: string;
    parentId: string | null;
    replyToId: string | null;
    forwarded: boolean;
    sendAt: Date;
    failure: string | null;
    failedAt: Date | null;
    clientKey: string | null;
    e2eeCiphertext: Uint8Array | null;
    e2eeEpoch: bigint | null;
    e2eeSenderLeaf: number | null;
    e2eeDevice: string | null;
    e2eeSignature: Uint8Array | null;
    files: Record<string, unknown>[];
}

const state = vi.hoisted(() => ({
    rows: [] as Row[],
    groupEpoch: 5n as bigint | null,
    sealedSends: [] as { input: Record<string, unknown>; files: readonly Record<string, unknown>[] }[],
    claimed: [] as string[],
    removed: [] as string[],
    created: 0,
    /** What the next `findFirst` answers instead: a tab that read the row before another sealed it. */
    stale: null as unknown,
    /** What this device opens and seals again, for the list helpers. */
    opens: new Map<string, { body: string; files?: { name: string; type: string }[] } | null>(),
    resealed: [] as string[]
}));

class FakeAccessError extends Error {
    constructor(text?: string | ChatText) {
        super(typeof text === "object" ? chatText("en-US", text) : text);
    }
}

class FakeRefusal extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeAccessError,
    requirePostable: async () => ({ channelId: "c1", mayPost: true })
}));
vi.mock("@/lib/chat/messages", () => ({ refusePlainIfSealed: async () => undefined, send: async () => "plain" }));
vi.mock("@/lib/chat/room-mentions", () => ({ refuseRoomMention: async () => undefined }));
vi.mock("@/lib/chat/attachments", () => ({
    removeStoredFiles: async (files: readonly { path: string }[]) => {
        state.removed.push(...files.map((file) => file.path));
    }
}));
vi.mock("@/lib/chat/e2ee/sealed-messages", () => ({
    SealedRefusal: FakeRefusal,
    verifySeal: async () => ({ groupEpoch: state.groupEpoch }),
    sealedFiles: async (_user: string, _channel: string, ids: readonly string[]) => {
        state.claimed.push(...ids);
        return ids.map((id) => ({ id, sealed: true, name: "file", size: 4, contentType: "application/octet-stream", connectionId: null, path: `sealed/${id}` }));
    },
    sendSealed: async (_user: string, input: Record<string, unknown>, files: readonly Record<string, unknown>[]) => {
        state.sealedSends.push({ input, files });
        return "m1";
    }
}));

/** A row matches when every field the query names is equal (and the epoch CAS holds). */
function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "sendAt") return row.sendAt.getTime() <= (value as { lte: Date }).lte.getTime();
        return (row as unknown as Record<string, unknown>)[key] === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatScheduledMessage: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                if (state.stale) {
                    const stale = state.stale;
                    state.stale = null;
                    return stale;
                }
                return state.rows.find((row) => matches(row, where)) ?? null;
            },
            findMany: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter((row) => matches(row, where)),
            create: async ({ data }: { data: Record<string, unknown> }) => {
                state.created += 1;
                const row: Row = {
                    id: `s${state.created}`,
                    channelId: String(data.channelId),
                    authorId: String(data.authorId),
                    body: String(data.body),
                    parentId: (data.parentId as string | null) ?? null,
                    replyToId: (data.replyToId as string | null) ?? null,
                    forwarded: false,
                    sendAt: data.sendAt as Date,
                    failure: null,
                    failedAt: null,
                    clientKey: data.clientKey as string,
                    e2eeCiphertext: data.e2eeCiphertext as Uint8Array,
                    e2eeEpoch: data.e2eeEpoch as bigint,
                    e2eeSenderLeaf: data.e2eeSenderLeaf as number,
                    e2eeDevice: data.e2eeDevice as string,
                    e2eeSignature: data.e2eeSignature as Uint8Array,
                    files: (data.files as { create: Record<string, unknown>[] }).create.map((file) => ({ ...file }))
                };
                state.rows.push(row);
                return { id: row.id };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = state.rows.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return {};
            },
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
                const hit = state.rows.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            delete: async ({ where }: { where: { id: string } }) => {
                state.rows = state.rows.filter((row) => row.id !== where.id);
                return {};
            }
        },
        mlsGroup: { findUnique: async () => (state.groupEpoch === null ? null : { epoch: state.groupEpoch }) },
        mlsDevice: { findMany: async () => [{ device: "dev-1", signatureKey: new Uint8Array([7, 7]) }] }
    }
}));

vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => true,
    openScheduled: async (_channel: string, rows: readonly { id: string }[]) => new Map(rows.map((row) => [row.id, state.opens.get(row.id) ?? null])),
    resealScheduled: async (_channel: string, rows: readonly { id: string }[]) => {
        state.resealed.push(...rows.map((row) => row.id));
        return rows.length;
    }
}));

const { openedScheduled, resealDue } = await import("@/app/(app)/chat/sealed-scheduled");
const { listScheduled, resealScheduled, scheduleSealed, sendScheduledNow, sweepDueScheduledMessages } = await import("@/lib/chat/scheduled");

const ME = { id: "ada" };
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function seal(epoch: bigint, extra: Record<string, unknown> = {}) {
    return {
        channelId: CHANNEL,
        device: "dev-1",
        clientKey: "22222222-2222-4222-8222-222222222222",
        epoch,
        senderLeaf: 0,
        ciphertext: new Uint8Array([1, 2, 3]),
        signature: new Uint8Array([4, 5]),
        sendAt: IN_AN_HOUR(),
        ...extra
    };
}

/** Bring a written row's hour forward, so the sweep finds it due. */
function due(id: string): void {
    const row = state.rows.find((entry) => entry.id === id)!;
    row.sendAt = new Date(Date.now() - 1000);
}

beforeEach(() => {
    state.stale = null;
    state.opens = new Map();
    state.resealed = [];
    state.rows = [];
    state.groupEpoch = 5n;
    state.sealedSends = [];
    state.claimed = [];
    state.removed = [];
    state.created = 0;
});

describe("writing a sealed one down", () => {
    it("keeps the seal and an empty body, never words", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        const row = state.rows.find((entry) => entry.id === id)!;
        expect(row.body).toBe("");
        expect(row.e2eeEpoch).toBe(5n);
        expect(row.e2eeCiphertext).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("answers the same row for a repeat with the same client key", async () => {
        const first = await scheduleSealed(ME, seal(5n));
        const again = await scheduleSealed(ME, seal(5n));
        expect(again).toBe(first);
        expect(state.rows).toHaveLength(1);
    });

    it("refuses a seal made at an older epoch than the conversation's", async () => {
        await expect(scheduleSealed(ME, seal(4n))).rejects.toMatchObject({ reason: "olderEpoch" });
        expect(state.rows).toHaveLength(0);
    });

    it("claims its sealed uploads into rows that keep the upload's id", async () => {
        const upload = "33333333-3333-4333-8333-333333333333";
        const id = await scheduleSealed(ME, seal(5n, { uploads: [upload] }));
        expect(state.claimed).toEqual([upload]);
        const row = state.rows.find((entry) => entry.id === id)!;
        expect(row.files).toEqual([expect.objectContaining({ id: upload, sealed: true, path: `sealed/${upload}` })]);
    });

    it("refuses a moment that has already been", async () => {
        await expect(scheduleSealed(ME, seal(5n, { sendAt: new Date(Date.now() - 60_000).toISOString() }))).rejects.toBeInstanceOf(FakeAccessError);
    });
});

describe("the hour coming round", () => {
    it("sends it as sealed, with its files, at the epoch it was sealed in", async () => {
        const upload = "33333333-3333-4333-8333-333333333333";
        const id = await scheduleSealed(ME, seal(5n, { uploads: [upload] }));
        due(id);
        expect(await sweepDueScheduledMessages()).toEqual({ sent: 1, failed: 0 });
        expect(state.sealedSends).toHaveLength(1);
        expect(state.sealedSends[0]!.input).toMatchObject({ epoch: 5n, device: "dev-1", clientKey: "22222222-2222-4222-8222-222222222222" });
        expect(state.sealedSends[0]!.files).toEqual([expect.objectContaining({ id: upload, sealed: true })]);
        expect(state.rows).toHaveLength(0);
    });

    it("sets it aside with a reason once the conversation rekeyed, and keeps its files", async () => {
        const id = await scheduleSealed(ME, seal(5n, { uploads: ["33333333-3333-4333-8333-333333333333"] }));
        due(id);
        state.groupEpoch = 6n;
        expect(await sweepDueScheduledMessages()).toEqual({ sent: 0, failed: 1 });
        expect(state.sealedSends).toHaveLength(0);
        const row = state.rows.find((entry) => entry.id === id)!;
        expect(row.failure).toBe(chatText("en-US", { key: "errors.schedule.sealedKeysChanged" }));
        expect(state.removed).toEqual([]);
    });

    it("refuses Send now under an older epoch too", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        state.groupEpoch = 6n;
        await expect(sendScheduledNow(ME, id)).rejects.toBeInstanceOf(FakeAccessError);
        expect(state.sealedSends).toHaveLength(0);
    });
});

describe("sealing it again", () => {
    it("takes the new seal, clears the failure and lets it go at the next pass", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        due(id);
        state.groupEpoch = 6n;
        await sweepDueScheduledMessages();
        await resealScheduled(ME, { ...seal(6n), id, ciphertext: new Uint8Array([9]) });
        const row = state.rows.find((entry) => entry.id === id)!;
        expect(row.e2eeEpoch).toBe(6n);
        expect(row.failure).toBeNull();
        expect(row.failedAt).toBeNull();
        expect(await sweepDueScheduledMessages()).toEqual({ sent: 1, failed: 0 });
        expect(state.sealedSends[0]!.input).toMatchObject({ epoch: 6n, ciphertext: new Uint8Array([9]) });
    });

    it("refuses a reseal at anything but the conversation's current epoch", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        state.groupEpoch = 7n;
        await expect(resealScheduled(ME, { ...seal(6n), id })).rejects.toMatchObject({ reason: "olderEpoch" });
        expect(state.rows[0]!.e2eeEpoch).toBe(5n);
    });

    it("lands only over the seal it was read at (two tabs cannot both write)", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        const readAtFive = { ...state.rows[0]! };
        state.groupEpoch = 6n;
        await resealScheduled(ME, { ...seal(6n), id, ciphertext: new Uint8Array([8]) });
        // A second tab that read the row while it was still at epoch 5: its write misses.
        state.stale = readAtFive;
        await resealScheduled(ME, { ...seal(6n), id, ciphertext: new Uint8Array([9]) });
        expect(state.rows[0]!.e2eeCiphertext).toEqual(new Uint8Array([8]));
    });

    it("refuses somebody else's row", async () => {
        const id = await scheduleSealed(ME, seal(5n));
        await expect(resealScheduled({ id: "eve" }, { ...seal(5n), id })).rejects.toBeInstanceOf(FakeAccessError);
    });
});

describe("the writer's list", () => {
    it("hands the seal back with the device's signature key, and flags a rekeyed one", async () => {
        await scheduleSealed(ME, seal(5n));
        const [fresh] = await listScheduled(ME, CHANNEL);
        expect(fresh!.body).toBe("");
        expect(fresh!.sealed).toMatchObject({ device: "dev-1", epoch: "5", senderLeaf: 0 });
        expect(fresh!.resealDue).toBe(false);
        state.groupEpoch = 6n;
        const [moved] = await listScheduled(ME, CHANNEL);
        expect(moved!.resealDue).toBe(true);
    });
});

describe("the list above the box", () => {
    const sealedRow = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        channelId: CHANNEL,
        body: "",
        sendAt: IN_AN_HOUR(),
        files: [{ name: "file", contentType: "application/octet-stream" }],
        replying: false,
        failure: null,
        sealed: { clientKey: "k", device: "dev-1", epoch: "5", senderLeaf: 0, ciphertext: "c", signature: "s", signatureKey: "p" },
        resealDue: false,
        ...extra
    });

    it("shows a sealed one's words and file names from its seal", async () => {
        state.opens.set("a", { body: "see you at nine", files: [{ name: "plan.pdf", type: "application/pdf" }] });
        const [shown] = await openedScheduled(CHANNEL, [sealedRow("a")]);
        expect(shown).toMatchObject({ body: "see you at nine", files: [{ name: "plan.pdf", contentType: "application/pdf" }] });
        expect(shown!.unopened).toBeUndefined();
    });

    it("marks one that does not open here instead of showing it empty", async () => {
        const [notHere, gone] = await openedScheduled(CHANNEL, [sealedRow("a"), sealedRow("b", { sealed: null })]);
        expect(notHere!.unopened).toBe(true);
        expect(gone!.unopened).toBe(true);
    });

    it("leaves a plain one as it is", async () => {
        const plain = { ...sealedRow("p", { body: "hello" }), sealed: undefined, resealDue: undefined };
        expect(await openedScheduled(CHANNEL, [plain])).toEqual([plain]);
    });

    it("seals again only the rekeyed ones it holds a seal for", async () => {
        const count = await resealDue(CHANNEL, [sealedRow("a"), sealedRow("b", { resealDue: true }), sealedRow("c", { resealDue: true, sealed: null })]);
        expect(count).toBe(1);
        expect(state.resealed).toEqual(["b"]);
    });
});
