/**
 * Sealed reactions (docs/chat-e2ee-mls.md, "Sealed reactions"): in a sealed
 * conversation the server keeps one opaque row per person and message and
 * never which emoji; a plain reaction there is refused; the person's earlier
 * plain reactions on the message go with their first sealed set; a set moved
 * to another message or person does not open; and the browser's counts, from
 * sets really sealed and opened, match what the plain path drew.
 */

import { fromText, toText } from "@/lib/chat/e2ee/base64url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as content from "@polaris/chat-crypto/message-content";

class FakeAccessError extends Error {
    constructor(text?: unknown) {
        super(typeof text === "object" ? String((text as { key: string }).key) : String(text));
    }
}
class FakeRuleError extends FakeAccessError {}

const CHANNEL = "0190a5b2-0000-7000-8000-000000000001";
const MESSAGE = "0190a5b2-0000-7000-8000-0000000000aa";
const OTHER = "0190a5b2-0000-7000-8000-0000000000ab";
const ALICE = "0190a5b2-0000-7000-8000-0000000000b1";
const BOB = "0190a5b2-0000-7000-8000-0000000000b2";
const HK = new Uint8Array(32).map((_, at) => at);

interface Row {
    messageId: string;
    userId: string;
    setId: string;
    epoch: bigint;
    sealed: Uint8Array;
}

let rows: Row[] = [];
let plain: { messageId: string; userId: string; emoji: string }[] = [];
let sealedConversation = true;
let published = 0;

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeAccessError,
    ChatRuleError: FakeRuleError,
    requireChannel: async () => ({ mayModerate: false }),
    requirePostable: async () => ({ mayModerate: false })
}));
vi.mock("@/lib/chat/history-visibility", () => ({
    requireReadable: async () => undefined,
    readableSince: async () => null,
    sinceClause: () => ({})
}));
vi.mock("@/lib/chat/e2ee/sealed-conversation", () => ({ conversationSealed: async () => sealedConversation }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => void (published += 1) }));

vi.mock("@polaris/db", () => {
    const sealedTable = {
        deleteMany: async ({ where }: { where: { messageId: string; userId: string } }) => {
            rows = rows.filter((row) => !(row.messageId === where.messageId && row.userId === where.userId));
        },
        upsert: async ({ where, create, update }: { where: { messageId_userId: { messageId: string; userId: string } }; create: Row; update: Partial<Row> }) => {
            const key = where.messageId_userId;
            const found = rows.find((row) => row.messageId === key.messageId && row.userId === key.userId);
            if (found) Object.assign(found, update);
            else rows.push({ ...create });
        },
        findMany: async ({ where, take }: { where: { messageId: { in: string[] }; OR?: unknown }; take?: number }) =>
            rows
                .filter((row) => where.messageId.in.includes(row.messageId))
                .sort((left, right) => (left.messageId + left.userId < right.messageId + right.userId ? -1 : 1))
                .slice(0, take)
    };
    const plainTable = {
        deleteMany: async ({ where }: { where: { messageId: string; userId: string } }) => {
            plain = plain.filter((row) => !(row.messageId === where.messageId && row.userId === where.userId));
        }
    };
    return {
        prisma: {
            chatMessage: {
                findUnique: async ({ where }: { where: { id: string } }) => ({ channelId: CHANNEL, audience: [], id: where.id }),
                findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id }))
            },
            mlsGroup: { findUnique: async () => ({ epoch: 5n }) },
            chatSealedReaction: sealedTable,
            chatReaction: plainTable,
            $transaction: async (run: (tx: unknown) => Promise<void>) => run({ chatSealedReaction: sealedTable, chatReaction: plainTable })
        }
    };
});

const service = await import("@/lib/chat/sealed-reactions");
const tally = await import("@/app/(app)/chat/sealed-reaction-tally");

async function sealedSet(reactor: string, emoji: string[], messageId = MESSAGE, epoch = 5n) {
    const setId = crypto.randomUUID();
    const sealed = await content.sealReactions(HK, { conversationId: CHANNEL, epoch, messageId, setId, reactor }, content.encodeReactions(emoji));
    return { setId, epoch: epoch.toString(), sealed: toText(sealed) };
}

async function openRow(row: { messageId: string; userId: string; setId: string; epoch: string; sealed: string }) {
    const binding = { conversationId: CHANNEL, epoch: BigInt(row.epoch), messageId: row.messageId, setId: row.setId, reactor: row.userId };
    const bytes = await content.openReactions(HK, binding, fromText(row.sealed)).catch(() => null);
    return bytes ? content.decodeReactions(bytes) : null;
}

beforeEach(() => {
    rows = [];
    plain = [];
    sealedConversation = true;
    published = 0;
});

describe("the sealed reaction set", () => {
    it("is one fixed size whatever it holds, and round-trips", async () => {
        const one = await sealedSet(ALICE, ["👍"]);
        const many = await sealedSet(ALICE, Array.from({ length: 20 }, (_, at) => `<:e${at}:0190a5b2-0000-7000-8000-0000000000${(10 + at).toString()}>`));
        expect(fromText(one.sealed).length).toBe(content.SEALED_REACTIONS_BYTES);
        expect(fromText(many.sealed).length).toBe(content.SEALED_REACTIONS_BYTES);
        expect(await openRow({ messageId: MESSAGE, userId: ALICE, ...one })).toEqual(["👍"]);
    });

    it("refuses more than the cap and does not open moved to another message or person", async () => {
        expect(() => content.encodeReactions(Array.from({ length: 21 }, (_, at) => String(at)))).toThrow(RangeError);
        const set = await sealedSet(ALICE, ["🎉"]);
        expect(await openRow({ messageId: OTHER, userId: ALICE, ...set })).toBeNull();
        expect(await openRow({ messageId: MESSAGE, userId: BOB, ...set })).toBeNull();
    });
});

describe("sealed reactions on the server", () => {
    it("keeps one opaque row per person and message, replaced on change and gone when emptied", async () => {
        await service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: await sealedSet(ALICE, ["👍"]) });
        await service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: await sealedSet(ALICE, ["👍", "🎉"]) });
        expect(rows).toHaveLength(1);
        expect(published).toBe(2);
        await service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: null });
        expect(rows).toHaveLength(0);
    });

    it("drops the person's plain reactions on the message with their first set", async () => {
        plain = [
            { messageId: MESSAGE, userId: ALICE, emoji: "👍" },
            { messageId: MESSAGE, userId: BOB, emoji: "👍" }
        ];
        await service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: await sealedSet(ALICE, ["👍"]) });
        expect(plain).toEqual([{ messageId: MESSAGE, userId: BOB, emoji: "👍" }]);
    });

    it("refuses a set in a plain conversation, of the wrong size, or at an epoch the group has not reached", async () => {
        const good = await sealedSet(ALICE, ["👍"]);
        await expect(service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: { ...good, sealed: toText(new Uint8Array(40)) } })).rejects.toThrow("errors.sealedOnlyReload");
        await expect(service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: { ...good, epoch: "6" } })).rejects.toThrow("errors.sealedOnlyReload");
        sealedConversation = false;
        await expect(service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: good })).rejects.toThrow("errors.sealedOnlyReload");
        expect(rows).toHaveLength(0);
    });

    it("hands the rows of the messages asked for out with their person, and pages", async () => {
        await service.putReactions({ id: ALICE }, { messageId: MESSAGE, set: await sealedSet(ALICE, ["👍"]) });
        await service.putReactions({ id: BOB }, { messageId: MESSAGE, set: await sealedSet(BOB, ["👍", "😂"]) });
        await service.putReactions({ id: BOB }, { messageId: OTHER, set: await sealedSet(BOB, ["🎉"], OTHER) });
        const page = await service.readReactions({ id: ALICE }, { channelId: CHANNEL, messageIds: [MESSAGE], after: null });
        expect(page.rows.map((row) => [row.userId, row.mine])).toEqual([
            [ALICE, true],
            [BOB, false]
        ]);
        expect(page.next).toBeNull();
        expect(service.readReactionsSchema.safeParse({ channelId: CHANNEL, messageIds: Array(101).fill(MESSAGE), after: null }).success).toBe(false);
    });
});

describe("the counts in the browser", () => {
    it("adds opened sets to the plain ones, once per person and emoji, custom emoji by id", () => {
        const plainViews = [{ emoji: "👍", count: 1, mine: false }];
        const merged = tally.withSealedReactions(plainViews, [
            { emoji: ["👍", "<:party:0190a5b2-0000-7000-8000-0000000000e1>"], mine: true },
            { emoji: ["<:fiesta:0190a5b2-0000-7000-8000-0000000000e1>"], mine: false },
            { emoji: null, mine: false }
        ]);
        expect(merged).toEqual([
            { emoji: "👍", count: 2, mine: true },
            { emoji: "<:fiesta:0190a5b2-0000-7000-8000-0000000000e1>", count: 2, mine: true }
        ]);
    });

    it("toggles one emoji in this person's set", () => {
        expect(tally.toggled(["👍"], "🎉", true)).toEqual(["👍", "🎉"]);
        expect(tally.toggled(["👍", "🎉"], "👍", false)).toEqual(["🎉"]);
        expect(tally.toggled(["👍"], "👍", true)).toEqual(["👍"]);
    });
});
