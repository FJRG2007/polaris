/**
 * Polls: what somebody picked, and when they may no longer pick it.
 *
 * Four rules with teeth here, and each one fails quietly if it is wrong.
 *
 * A vote is the whole selection rather than the one answer that changed, so
 * pressing the same answer twice takes it back and a single-choice poll replaces
 * rather than accumulates. Both are checked, because the failure mode of the
 * first is a vote nobody can withdraw and of the second is one person counted
 * three times.
 *
 * A closed poll is closed whether somebody ended it or the clock ran out, and
 * whether it is over is worked out on read - nothing runs to write a flag, so a
 * deployment with a wedged sweep must not leave every poll in it open forever.
 *
 * A hidden poll gives away nothing while it runs. Not the counts, not the
 * shares, not by omission - only which answer this reader picked, which is
 * theirs already.
 *
 * And a poll belongs to whoever asked it and whoever moderates the room. Anybody
 * else closing one is somebody ending a vote they were losing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    chatPollCreateSchema,
    normalizePollOptions,
    pollClosesAt,
    pollIsClosed,
    pollResultsVisible,
    POLL_NO_END
} from "@polaris/core";

interface OptionRow {
    id: string;
    text: string;
    position: number;
}

interface PollRow {
    messageId: string;
    multiple: boolean;
    hideResults: boolean;
    closesAt: Date | null;
    closedAt: Date | null;
    options: OptionRow[];
}

interface MessageRow {
    id: string;
    channelId: string;
    authorId: string | null;
    deletedAt: Date | null;
}

let polls: PollRow[] = [];
let messages: MessageRow[] = [];
let votes: { optionId: string; userId: string }[] = [];
/** What the access layer answers: whether this reader may post here at all, and
 *  whether they run the room. */
let postable = true;
let mayModerate = false;

class FakeAccessError extends Error {}
class FakeRuleError extends FakeAccessError {}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeAccessError,
    ChatRuleError: FakeRuleError,
    requireChannel: async (_actor: unknown, channelId: string) => ({ channelId, mayModerate }),
    requirePostable: async (_actor: unknown, channelId: string) => {
        if (!postable) throw new FakeAccessError("You are not in that conversation");
        return { channelId, mayPost: true, mayModerate };
    }
}));

vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

/** Every option id in the store, so a vote can be matched back to its poll. */
function optionsOf(ids: readonly string[]): OptionRow[] {
    return polls.flatMap((poll) => poll.options).filter((option) => ids.includes(option.id));
}

const store = {
    chatMessage: {
        findUnique: async ({ where }: { where: { id: string } }) => {
            const message = messages.find((row) => row.id === where.id);
            if (!message) return null;
            const poll = polls.find((row) => row.messageId === message.id);
            return {
                ...message,
                poll: poll
                    ? {
                          multiple: poll.multiple,
                          hideResults: poll.hideResults,
                          closesAt: poll.closesAt,
                          closedAt: poll.closedAt,
                          options: poll.options.map((option) => ({ id: option.id }))
                      }
                    : null
            };
        }
    },
    chatPoll: {
        findMany: async ({ where }: { where: { messageId: { in: string[] } } }) =>
            polls
                .filter((poll) => where.messageId.in.includes(poll.messageId))
                .map((poll) => ({
                    ...poll,
                    options: [...poll.options].sort((left, right) => left.position - right.position)
                })),
        update: async ({
            where,
            data
        }: {
            where: { messageId: string };
            data: { closedAt: Date };
        }) => {
            const poll = polls.find((row) => row.messageId === where.messageId);
            if (poll) poll.closedAt = data.closedAt;
            return {};
        }
    },
    chatPollVote: {
        findMany: async ({ where }: { where: { optionId: { in: string[] } } }) =>
            votes.filter((vote) => where.optionId.in.includes(vote.optionId)),
        deleteMany: async ({
            where
        }: {
            where: { userId: string; optionId: { in: string[] } };
        }) => {
            votes = votes.filter(
                (vote) =>
                    !(vote.userId === where.userId && where.optionId.in.includes(vote.optionId))
            );
            return {};
        },
        createMany: async ({ data }: { data: { optionId: string; userId: string }[] }) => {
            votes.push(...data);
            return {};
        }
    }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        ...store,
        $transaction: async (run: (tx: typeof store) => Promise<unknown>) => run(store)
    }
}));

const { endPoll, pollsFor, readPoll, vote } = await import("@/lib/chat/polls");

const ADA = { id: "ada" };
const GRACE = { id: "grace" };

/** One poll in one channel, with as many answers as it is given. */
function seed(
    options: Partial<PollRow> & { answers?: number; authorId?: string } = {}
): PollRow {
    const answers = options.answers ?? 2;
    const poll: PollRow = {
        messageId: "m1",
        multiple: options.multiple ?? false,
        hideResults: options.hideResults ?? false,
        closesAt: options.closesAt ?? null,
        closedAt: options.closedAt ?? null,
        options: Array.from({ length: answers }, (_, index) => ({
            id: `o${index + 1}`,
            text: `Answer ${index + 1}`,
            position: index
        }))
    };
    polls.push(poll);
    messages.push({
        id: poll.messageId,
        channelId: "c1",
        authorId: options.authorId ?? ADA.id,
        deletedAt: null
    });
    return poll;
}

beforeEach(() => {
    polls = [];
    messages = [];
    votes = [];
    postable = true;
    mayModerate = false;
});

describe("what is stored", () => {
    it("drops the boxes nobody filled in and the answers written twice", () => {
        expect(normalizePollOptions(["Pizza", "  ", "sushi", "SUSHI", "Pizza ", ""])).toEqual([
            "Pizza",
            "sushi"
        ]);
    });

    it("collapses the runs of whitespace inside an answer", () => {
        expect(normalizePollOptions(["  Thai   food "])).toEqual(["Thai food"]);
    });

    it("refuses a poll that is left with fewer than two answers", () => {
        const result = chatPollCreateSchema.safeParse({
            channelId: "6f1c4d1e-0000-4000-8000-000000000001",
            question: "Lunch?",
            options: ["Pizza", "pizza", "", "   "]
        });
        expect(result.success).toBe(false);
        expect(result.success === false && result.error.issues[0]?.message).toContain(
            "at least two"
        );
    });

    it("refuses a length nobody was offered", () => {
        const asked = {
            channelId: "6f1c4d1e-0000-4000-8000-000000000001",
            question: "Lunch?",
            options: ["Pizza", "Sushi"]
        };
        expect(chatPollCreateSchema.safeParse({ ...asked, hours: 5 }).success).toBe(false);
        expect(chatPollCreateSchema.safeParse({ ...asked, hours: 24 }).success).toBe(true);
        expect(chatPollCreateSchema.safeParse({ ...asked, hours: POLL_NO_END }).success).toBe(true);
    });

    it("defaults to a day, and to one answer with the counts on show", () => {
        const parsed = chatPollCreateSchema.parse({
            channelId: "6f1c4d1e-0000-4000-8000-000000000001",
            question: "Lunch?",
            options: ["Pizza", "Sushi"]
        });
        expect(parsed.hours).toBe(24);
        expect(parsed.multiple).toBe(false);
        expect(parsed.hideResults).toBe(false);
    });
});

describe("when a poll is over", () => {
    const NOW = new Date("2026-08-20T12:00:00Z");

    it("is over once the clock has run out, with nothing having to run", () => {
        const closesAt = pollClosesAt(1, NOW);
        expect(pollIsClosed({ closesAt, closedAt: null }, NOW)).toBe(false);
        expect(
            pollIsClosed({ closesAt, closedAt: null }, new Date(NOW.getTime() + 61 * 60 * 1000))
        ).toBe(true);
    });

    it("has no clock at all when nobody set one", () => {
        expect(pollClosesAt(POLL_NO_END, NOW)).toBeNull();
        expect(pollIsClosed({ closesAt: null, closedAt: null }, NOW)).toBe(false);
    });

    it("is over the moment somebody ends it, whatever the clock says", () => {
        expect(
            pollIsClosed({ closesAt: pollClosesAt(336, NOW), closedAt: NOW }, NOW)
        ).toBe(true);
    });

    it("keeps a hidden poll hidden until then, and never a shown one", () => {
        const open = { hideResults: true, closesAt: pollClosesAt(1, NOW), closedAt: null };
        expect(pollResultsVisible(open, NOW)).toBe(false);
        expect(pollResultsVisible({ ...open, closedAt: NOW }, NOW)).toBe(true);
        expect(pollResultsVisible({ ...open, hideResults: false }, NOW)).toBe(true);
    });
});

describe("voting", () => {
    it("replaces the previous answer when only one may be picked", async () => {
        seed();
        await vote(GRACE, { messageId: "m1", optionIds: ["o1"] });
        await vote(GRACE, { messageId: "m1", optionIds: ["o2"] });
        expect(votes).toEqual([{ optionId: "o2", userId: "grace" }]);
    });

    it("keeps several when the poll allows them", async () => {
        seed({ multiple: true, answers: 3 });
        await vote(GRACE, { messageId: "m1", optionIds: ["o1", "o3"] });
        expect(votes.map((entry) => entry.optionId).sort()).toEqual(["o1", "o3"]);
    });

    it("takes the vote back on an empty selection", async () => {
        seed();
        await vote(GRACE, { messageId: "m1", optionIds: ["o1"] });
        await vote(GRACE, { messageId: "m1", optionIds: [] });
        expect(votes).toEqual([]);
    });

    it("leaves everybody else's votes alone", async () => {
        seed();
        await vote(ADA, { messageId: "m1", optionIds: ["o1"] });
        await vote(GRACE, { messageId: "m1", optionIds: ["o2"] });
        await vote(GRACE, { messageId: "m1", optionIds: [] });
        expect(votes).toEqual([{ optionId: "o1", userId: "ada" }]);
    });

    it("refuses more than one answer where only one may be picked", async () => {
        seed({ answers: 3 });
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["o1", "o2"] })).rejects.toThrow(
            /one answer/i
        );
        expect(votes).toEqual([]);
    });

    it("refuses an answer that belongs to another poll", async () => {
        seed();
        polls.push({
            messageId: "m2",
            multiple: false,
            hideResults: false,
            closesAt: null,
            closedAt: null,
            options: [{ id: "elsewhere", text: "Somewhere else", position: 0 }]
        });
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["elsewhere"] })).rejects.toThrow();
        expect(votes).toEqual([]);
    });

    it("refuses once it has been ended, and once the clock has run out", async () => {
        const ended = seed();
        ended.closedAt = new Date();
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["o1"] })).rejects.toThrow(
            /closed/i
        );

        polls = [];
        messages = [];
        const lapsed = seed();
        lapsed.closesAt = new Date(Date.now() - 1000);
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["o1"] })).rejects.toThrow(
            /closed/i
        );
        expect(votes).toEqual([]);
    });

    it("refuses somebody who may not speak in the room", async () => {
        seed();
        postable = false;
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["o1"] })).rejects.toThrow();
        expect(votes).toEqual([]);
    });

    it("refuses a poll whose message was taken back", async () => {
        seed();
        messages[0]!.deletedAt = new Date();
        await expect(vote(GRACE, { messageId: "m1", optionIds: ["o1"] })).rejects.toThrow(
            /deleted/i
        );
    });
});

describe("ending one", () => {
    it("is the asker's to do", async () => {
        seed({ authorId: ADA.id });
        await endPoll(ADA, "m1");
        expect(polls[0]?.closedAt).not.toBeNull();
    });

    it("is not a stranger's", async () => {
        seed({ authorId: ADA.id });
        await expect(endPoll(GRACE, "m1")).rejects.toThrow(/not your poll/i);
        expect(polls[0]?.closedAt).toBeNull();
    });

    it("is a moderator's, in the room they moderate", async () => {
        seed({ authorId: ADA.id });
        mayModerate = true;
        await endPoll(GRACE, "m1");
        expect(polls[0]?.closedAt).not.toBeNull();
    });

    it("does not complain when two people press it at once", async () => {
        seed({ authorId: ADA.id });
        await endPoll(ADA, "m1");
        const closedAt = polls[0]?.closedAt;
        await expect(endPoll(ADA, "m1")).resolves.toBeUndefined();
        // And it keeps the first moment: a second press must not move when it
        // ended, which is the timestamp the card is reading.
        expect(polls[0]?.closedAt).toBe(closedAt);
    });
});

describe("what the card is given", () => {
    it("counts people rather than presses", async () => {
        seed({ multiple: true, answers: 3 });
        await vote(ADA, { messageId: "m1", optionIds: ["o1", "o2", "o3"] });
        await vote(GRACE, { messageId: "m1", optionIds: ["o1"] });

        const view = (await pollsFor(GRACE.id, ["m1"])).get("m1");
        expect(view?.voters).toBe(2);
        expect(view?.options.map((option) => option.votes)).toEqual([2, 1, 1]);
        expect(view?.options.map((option) => option.mine)).toEqual([true, false, false]);
        expect(view?.voted).toBe(true);
    });

    it("keeps the answers in the order they were written", async () => {
        seed({ answers: 3 });
        const view = (await pollsFor(ADA.id, ["m1"])).get("m1");
        expect(view?.options.map((option) => option.text)).toEqual([
            "Answer 1",
            "Answer 2",
            "Answer 3"
        ]);
    });

    it("gives away no count at all while a hidden poll is running", async () => {
        seed({ hideResults: true });
        await vote(ADA, { messageId: "m1", optionIds: ["o1"] });
        await vote(GRACE, { messageId: "m1", optionIds: ["o1"] });

        const running = (await pollsFor(GRACE.id, ["m1"])).get("m1");
        expect(running?.results).toBe(false);
        expect(running?.options.map((option) => option.votes)).toEqual([0, 0]);
        // Their own answer is still theirs to see, and so is the fact that two
        // people have taken part - neither says what anybody chose.
        expect(running?.options[0]?.mine).toBe(true);
        expect(running?.voters).toBe(2);

        polls[0]!.closedAt = new Date();
        const over = (await pollsFor(GRACE.id, ["m1"])).get("m1");
        expect(over?.results).toBe(true);
        expect(over?.options.map((option) => option.votes)).toEqual([2, 0]);
    });

    it("says whether it ran out or was ended, which are different things", async () => {
        const poll = seed({ closesAt: new Date(Date.now() - 1000) });
        const lapsed = (await pollsFor(ADA.id, ["m1"])).get("m1");
        expect(lapsed?.closed).toBe(true);
        expect(lapsed?.endedEarly).toBe(false);

        poll.closedAt = new Date();
        expect((await pollsFor(ADA.id, ["m1"])).get("m1")?.endedEarly).toBe(true);
    });

    it("hands back nothing for a message that is not a poll", async () => {
        messages.push({ id: "plain", channelId: "c1", authorId: ADA.id, deletedAt: null });
        expect((await pollsFor(ADA.id, ["plain"])).size).toBe(0);
        await expect(readPoll(ADA, "plain")).resolves.toBeNull();
    });

    it("proves the conversation before it hands one back on its own", async () => {
        seed();
        await vote(ADA, { messageId: "m1", optionIds: ["o1"] });
        const view = await readPoll(GRACE, "m1");
        expect(view?.voters).toBe(1);
        expect(view?.voted).toBe(false);
    });
});
