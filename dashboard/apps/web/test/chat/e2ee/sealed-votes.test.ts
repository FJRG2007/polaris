/**
 * Sealed votes (docs/chat-e2ee-mls.md, "Sealed votes"): the server keeps one
 * opaque ballot per voter of a sealed poll and never what it picks; it hands a
 * hidden poll's ballots to nobody but their voter until it closes, an
 * anonymous poll's without voters and in random-id order, and a public one's
 * named; a plain vote on a sealed poll is refused; and the browser's tally,
 * from ballots really sealed and opened, counts each person once and discards
 * ballots the poll cannot take.
 */

import type { ChatPollView } from "@/lib/chat/polls";
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
const POLL = "0190a5b2-0000-7000-8000-0000000000aa";
const OPTIONS = ["0190a5b2-0000-7000-8000-0000000000c0", "0190a5b2-0000-7000-8000-0000000000c1", "0190a5b2-0000-7000-8000-0000000000c2"];
const ALICE = "0190a5b2-0000-7000-8000-0000000000b1";
const BOB = "0190a5b2-0000-7000-8000-0000000000b2";
const HK = new Uint8Array(32).map((_, at) => at);

interface Ballot {
    pollId: string;
    userId: string;
    ballotId: string;
    epoch: bigint;
    sealed: Uint8Array;
}

let ballots: Ballot[] = [];
let plainVotes: { optionId: string; userId: string }[] = [];
let poll = { multiple: false, hideResults: false, anonymous: true, closesAt: null as Date | null, closedAt: null as Date | null };
let sealedMessage = true;
/** Whether the conversation itself is sealed (its MLS group exists or the migration cut it). */
let sealedConversation = true;
let published = 0;

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeAccessError,
    ChatRuleError: FakeRuleError,
    requireChannel: async () => ({ mayModerate: false }),
    requirePostable: async () => ({ mayModerate: false })
}));
vi.mock("@/lib/chat/history-visibility", () => ({ requireReadable: async () => undefined }));
vi.mock("@/app/(app)/chat/actions", () => ({}));
vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({}));
vi.mock("@/lib/chat/e2ee/sealed-conversation", () => ({ conversationSealed: async () => sealedConversation }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => void (published += 1) }));

vi.mock("@polaris/db", () => {
    const ballotTable = {
        deleteMany: async ({ where }: { where: { pollId: string; userId: string } }) => {
            ballots = ballots.filter((row) => !(row.pollId === where.pollId && row.userId === where.userId));
        },
        upsert: async ({ where, create, update }: { where: { pollId_userId: { pollId: string; userId: string } }; create: Ballot; update: Partial<Ballot> }) => {
            const key = where.pollId_userId;
            const found = ballots.find((row) => row.pollId === key.pollId && row.userId === key.userId);
            if (found) Object.assign(found, update);
            else ballots.push({ ...create });
        },
        findMany: async ({ where, take, select }: { where: { pollId: string | { in: string[] }; userId?: string; ballotId?: { gt: string } }; take?: number; select: Record<string, unknown> }) => {
            const rows = ballots
                .filter((row) => (typeof where.pollId === "string" ? row.pollId === where.pollId : where.pollId.in.includes(row.pollId)))
                .filter((row) => !where.userId || row.userId === where.userId)
                .filter((row) => !where.ballotId || row.ballotId > where.ballotId.gt)
                .sort((left, right) => (left.ballotId < right.ballotId ? -1 : 1))
                .slice(0, take);
            return rows.map((row) => ({ ...row, ...(select.user ? { user: { id: row.userId, name: row.userId === ALICE ? "Alice" : "Bob" } } : {}) }));
        }
    };
    const voteTable = {
        deleteMany: async ({ where }: { where: { userId: string; optionId: { in: string[] } } }) => {
            plainVotes = plainVotes.filter((vote) => !(vote.userId === where.userId && where.optionId.in.includes(vote.optionId)));
        }
    };
    return {
        prisma: {
            chatMessage: {
                findUnique: async () => ({
                    channelId: CHANNEL,
                    deletedAt: null,
                    e2eeEpoch: sealedMessage ? 3n : null,
                    poll: { ...poll, options: OPTIONS.map((id) => ({ id })) }
                })
            },
            mlsGroup: { findUnique: async () => ({ epoch: 5n }) },
            chatPollBallot: ballotTable,
            chatPollVote: voteTable,
            $transaction: async (run: (tx: unknown) => Promise<void>) => run({ chatPollBallot: ballotTable, chatPollVote: voteTable })
        }
    };
});

const service = await import("@/lib/chat/poll-ballots");
const tally = await import("@/app/(app)/chat/sealed-votes");

async function sealedBallot(voter: string | null, picks: number[], epoch = 5n) {
    const ballotId = crypto.randomUUID();
    const sealed = await content.sealBallot(HK, { conversationId: CHANNEL, epoch, pollId: POLL, ballotId, voter }, content.encodeBallot(picks));
    return { ballotId, epoch: epoch.toString(), sealed: toText(sealed) };
}

async function opened(page: Awaited<ReturnType<typeof service.readBallots>>, viewer: string) {
    return Promise.all(
        page.ballots.map(async (row) => {
            const voter = poll.anonymous ? null : (row.voter?.id ?? (row.mine ? viewer : null));
            const binding = { conversationId: CHANNEL, epoch: BigInt(row.epoch), pollId: POLL, ballotId: row.ballotId, voter };
            const bytes = await content.openBallot(HK, binding, fromText(row.sealed)).catch(() => null);
            return { picks: bytes ? content.decodeBallot(bytes) : null, mine: row.mine, ...(row.voter ? { voter: row.voter } : {}) };
        })
    );
}

function view(overrides: Partial<ChatPollView> = {}): ChatPollView {
    return {
        multiple: poll.multiple,
        hideResults: poll.hideResults,
        anonymous: poll.anonymous,
        sealedVotes: true,
        closed: false,
        closesAt: null,
        endedEarly: false,
        results: true,
        voters: 0,
        voted: false,
        options: OPTIONS.map((id, at) => ({ id, text: `answer ${at}`, votes: 0, mine: false })),
        ...overrides
    };
}

beforeEach(() => {
    ballots = [];
    plainVotes = [];
    poll = { multiple: false, hideResults: false, anonymous: true, closesAt: null, closedAt: null };
    sealedMessage = true;
    sealedConversation = true;
    published = 0;
});

describe("sealed ballots on the server", () => {
    it("keeps one opaque ballot per voter, replaced by a new one and gone when taken back", async () => {
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [0]) });
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [1]) });
        expect(ballots).toHaveLength(1);
        expect(ballots[0]!.sealed).toHaveLength(content.SEALED_BALLOT_BYTES);
        // Nothing stored names an answer.
        expect(Object.keys(ballots[0]!).sort()).toEqual(["ballotId", "epoch", "pollId", "sealed", "updatedAt", "userId"]);
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: null });
        expect(ballots).toHaveLength(0);
        expect(published).toBe(3);
    });

    it("drops the voter's vote cast in the clear before with their first ballot", async () => {
        plainVotes = [{ optionId: OPTIONS[0]!, userId: ALICE }, { optionId: OPTIONS[1]!, userId: BOB }];
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [2]) });
        expect(plainVotes).toEqual([{ optionId: OPTIONS[1]!, userId: BOB }]);
    });

    it("refuses a ballot that is not one, at an epoch the group has not reached, on a closed or plain poll", async () => {
        const good = await sealedBallot(null, [0]);
        await expect(service.castBallot({ id: ALICE }, { messageId: POLL, ballot: { ...good, sealed: toText(new Uint8Array(40)) } })).rejects.toThrow("errors.voteNotCounted");
        await expect(service.castBallot({ id: ALICE }, { messageId: POLL, ballot: { ...good, epoch: "6" } })).rejects.toThrow("errors.voteNotCounted");
        poll.closedAt = new Date(Date.now() - 1000);
        await expect(service.castBallot({ id: ALICE }, { messageId: POLL, ballot: good })).rejects.toThrow("errors.pollClosed");
        poll.closedAt = null;
        sealedMessage = false;
        sealedConversation = false;
        await expect(service.castBallot({ id: ALICE }, { messageId: POLL, ballot: good })).rejects.toThrow("errors.voteNotCounted");
        expect(ballots).toHaveLength(0);
    });

    it("takes sealed ballots on a plain poll sent before the conversation was sealed, and drops its clear vote", async () => {
        sealedMessage = false;
        plainVotes = [{ optionId: OPTIONS[0]!, userId: ALICE }];
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [1]) });
        expect(ballots).toHaveLength(1);
        expect(plainVotes).toEqual([]);
        const page = await service.readBallots({ id: ALICE }, { messageId: POLL, after: null });
        expect((await opened(page, ALICE)).map((row) => row.picks)).toEqual([[1]]);
    });

    it("validates what it is sent", () => {
        expect(service.castBallotSchema.safeParse({ messageId: POLL, ballot: { ballotId: "x", epoch: "1", sealed: "AA" } }).success).toBe(false);
        expect(service.castBallotSchema.safeParse({ messageId: POLL, ballot: { ballotId: crypto.randomUUID(), epoch: "-1", sealed: "AA" } }).success).toBe(false);
        expect(service.castBallotSchema.safeParse({ messageId: POLL, ballot: { ballotId: crypto.randomUUID(), epoch: "1", sealed: "A".repeat(65) } }).success).toBe(false);
        expect(service.castBallotSchema.safeParse({ messageId: POLL, ballot: null }).success).toBe(true);
    });

    it("hands an anonymous poll's ballots out without their voters", async () => {
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [0]) });
        await service.castBallot({ id: BOB }, { messageId: POLL, ballot: await sealedBallot(null, [0]) });
        const page = await service.readBallots({ id: ALICE }, { messageId: POLL, after: null });
        expect(page.ballots).toHaveLength(2);
        expect(page.ballots.every((row) => row.voter === undefined)).toBe(true);
        expect(page.ballots.filter((row) => row.mine)).toHaveLength(1);
        expect(page.ballots.map((row) => row.ballotId)).toEqual([...page.ballots.map((row) => row.ballotId)].sort());
        const counted = tally.withBallots(view(), await opened(page, ALICE));
        expect(counted.options.map((option) => option.votes)).toEqual([2, 0, 0]);
        expect(counted.options.map((option) => option.mine)).toEqual([true, false, false]);
    });

    it("keeps everybody else's ballot back while a hidden poll runs", async () => {
        poll.hideResults = true;
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(null, [1]) });
        await service.castBallot({ id: BOB }, { messageId: POLL, ballot: await sealedBallot(null, [0]) });
        const page = await service.readBallots({ id: ALICE }, { messageId: POLL, after: null });
        expect(page.ballots).toHaveLength(1);
        expect(page.ballots[0]!.mine).toBe(true);
        const counted = tally.withBallots(view({ results: false }), await opened(page, ALICE));
        expect(counted.options.map((option) => option.votes)).toEqual([0, 0, 0]);
        expect(counted.options[1]!.mine).toBe(true);
    });

    it("names a public poll's voters, and a ballot moved to another voter does not open", async () => {
        poll.anonymous = false;
        await service.castBallot({ id: ALICE }, { messageId: POLL, ballot: await sealedBallot(ALICE, [2]) });
        // Bob's row holds a ballot sealed as Alice's: what a server swapping rows would hand out.
        await service.castBallot({ id: BOB }, { messageId: POLL, ballot: await sealedBallot(ALICE, [0]) });
        const page = await service.readBallots({ id: BOB }, { messageId: POLL, after: null });
        const open = await opened(page, BOB);
        expect(open.find((row) => row.voter?.id === ALICE)!.picks).toEqual([2]);
        expect(open.find((row) => row.voter?.id === BOB)!.picks).toBeNull();
        const counted = tally.withBallots(view({ anonymous: false }), open);
        expect(counted.options.map((option) => option.votes)).toEqual([0, 0, 1]);
        expect(tally.votersByAnswer(view({ anonymous: false }), open).get(OPTIONS[2]!)).toEqual([{ id: ALICE, name: "Alice" }]);
    });

    it("pages by ballot id", async () => {
        for (let at = 0; at < service.BALLOT_PAGE + 2; at += 1)
            ballots.push({ pollId: POLL, userId: crypto.randomUUID(), ballotId: crypto.randomUUID(), epoch: 5n, sealed: new Uint8Array(21) });
        const first = await service.readBallots({ id: ALICE }, { messageId: POLL, after: null });
        expect(first.ballots).toHaveLength(service.BALLOT_PAGE);
        const second = await service.readBallots({ id: ALICE }, { messageId: POLL, after: first.next });
        expect(second.ballots).toHaveLength(2);
        expect(second.next).toBeNull();
    });
});

describe("the tally in the browser", () => {
    it("discards ballots the poll cannot take, and counts over the votes cast in the clear", () => {
        const counted = tally.withBallots(view({ options: OPTIONS.map((id, at) => ({ id, text: "", votes: at === 1 ? 4 : 0, mine: false })) }), [
            { picks: [0], mine: false },
            { picks: [0, 1], mine: false },
            { picks: [7], mine: false },
            { picks: [], mine: false },
            { picks: null, mine: false },
            { picks: [1], mine: true }
        ]);
        expect(counted.options.map((option) => option.votes)).toEqual([1, 5, 0]);
        expect(counted.options.map((option) => option.mine)).toEqual([false, true, false]);
        poll.multiple = true;
        expect(tally.withBallots(view(), [{ picks: [0, 1], mine: false }]).options.map((option) => option.votes)).toEqual([1, 1, 0]);
    });
});
