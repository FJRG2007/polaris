/**
 * Polls: reading one back, voting in it, and closing it.
 *
 * A poll is a message. It is created by `messages.send` with the answers handed
 * to it, so everything that surrounds a message - the rules of the room, slow
 * mode, blocks, the read mark, the rail's ordering, the toast - happens once and
 * in one place. What lives here is the part that is only a poll's: the tallies,
 * the vote, and the end.
 *
 * Nothing is counted ahead of time. The numbers on the card are counted from the
 * votes on every read, because a running total kept on the poll would be a
 * second source of truth for the one number the whole feature is about - and the
 * first write lost to a retry would leave it wrong forever with nothing to
 * compare it against. A poll is a handful of rows; counting them is cheap.
 *
 * Authorization is `access.ts`, like everywhere else in Chat. Voting is
 * participating, so it asks the same question posting does: somebody who may not
 * speak in a room may not vote in it either, and a timeout or an archived
 * channel stops both.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { ChatAccessError, ChatRuleError, requireChannel, requirePostable } from "./access";
import * as history from "./history-visibility";
import { conversationSealed, sealedConversations } from "./e2ee/sealed-conversation";

/** One answer, already counted for the reader looking at it. */
export interface ChatPollOptionView {
    readonly id: string;
    readonly text: string;
    /** How many picked it. Zero for every answer while a hidden poll is still
     *  running - see `results`. */
    readonly votes: number;
    /** Whether the reader is one of them. Shown to the person who pressed it
     *  whether the poll hides its results or not: your own vote is yours to see,
     *  and a card that swallowed the press would read as broken. */
    readonly mine: boolean;
}

/** A poll as the message list draws it. */
export interface ChatPollView {
    /** Whether more than one answer may be picked. */
    readonly multiple: boolean;
    /** Whether the tallies are kept back until it closes. */
    readonly hideResults: boolean;
    /** Whether who picked what is never shown, to anybody. When false the card
     *  offers the list of who picked each answer, once the counts are showing. */
    readonly anonymous: boolean;
    /**
     * Voted on with sealed ballots (a poll in a sealed conversation): `votes`
     * and `mine` count only what was voted in the clear before, and the
     * browser adds the ballots it opens (`poll-ballots.ts`). `voters` and
     * `voted` already count both.
     */
    readonly sealedVotes?: boolean;
    /** Whether it is over, worked out now rather than read off a flag some job
     *  was supposed to have written. */
    readonly closed: boolean;
    /** When the clock runs out, or null for one that only a person ends. */
    readonly closesAt: string | null;
    /** Whether somebody ended it rather than it running out. The two are
     *  different facts, and the card says which. */
    readonly endedEarly: boolean;
    /**
     * Whether the counts below are real.
     *
     * False while a hidden poll is running, when every count is zero and the
     * card says the result is still coming rather than drawing empty bars -
     * which would read as "nobody has voted".
     */
    readonly results: boolean;
    /**
     * How many people have voted at all.
     *
     * Shown even on a hidden poll. It counts who has taken part rather than what
     * anybody chose, and it is the question people actually ask while one is
     * running: whether it is worth waiting for anybody else.
     */
    readonly voters: number;
    /** Whether the reader has voted. What turns "Pick one" into "Change your
     *  answer". */
    readonly voted: boolean;
    readonly options: readonly ChatPollOptionView[];
}

/** One vote, as the page asks for them all at once. */
interface VoteRow {
    optionId: string;
    userId: string;
}

/**
 * The polls on a page of messages, keyed by the message each belongs to.
 *
 * Two queries for the whole page rather than two per poll: the answers, then the
 * votes on those answers. The votes are reached through the answers rather than
 * through a column of their own - the answers have to be loaded to be drawn
 * anyway, so their ids are already in hand, and a second pointer at the poll
 * would be a copy of what the answer already says and one that could disagree
 * with it.
 */
export async function pollsFor(
    viewerId: string,
    messageIds: readonly string[],
    now: Date = new Date()
): Promise<Map<string, ChatPollView>> {
    const found = new Map<string, ChatPollView>();
    if (messageIds.length === 0) return found;

    const polls = await prisma.chatPoll.findMany({
        where: { messageId: { in: [...messageIds] } },
        select: {
            messageId: true,
            multiple: true,
            hideResults: true,
            anonymous: true,
            closesAt: true,
            closedAt: true,
            message: { select: { e2eeEpoch: true, channelId: true } },
            options: {
                orderBy: { position: "asc" },
                select: { id: true, text: true }
            }
        }
    });
    if (polls.length === 0) return found;

    // A poll takes sealed ballots when it was sent sealed or its conversation
    // has been sealed since (`poll-ballots.ts`).
    const sealedChannels = await sealedConversations(polls.flatMap((poll) => (poll.message ? [poll.message.channelId] : [])));
    const takesBallots = (poll: (typeof polls)[number]) =>
        poll.message?.e2eeEpoch != null || (poll.message != null && sealedChannels.has(poll.message.channelId));
    // Who cast a sealed ballot, never what it picks: the server cannot read that.
    const sealedIds = polls.filter(takesBallots).map((poll) => poll.messageId);
    const ballots = sealedIds.length
        ? await prisma.chatPollBallot.findMany({
              where: { pollId: { in: sealedIds } },
              select: { pollId: true, userId: true }
          })
        : [];

    const optionIds = polls.flatMap((poll) => poll.options.map((option) => option.id));
    const votes: VoteRow[] = optionIds.length
        ? await prisma.chatPollVote.findMany({
              where: { optionId: { in: optionIds } },
              select: { optionId: true, userId: true }
          })
        : [];

    const byOption = new Map<string, { count: number; mine: boolean }>();
    for (const cast of votes) {
        const tally = byOption.get(cast.optionId) ?? { count: 0, mine: false };
        tally.count += 1;
        if (cast.userId === viewerId) tally.mine = true;
        byOption.set(cast.optionId, tally);
    }

    for (const poll of polls) {
        const closed = core.pollIsClosed(poll, now);
        const results = core.pollResultsVisible(poll, now);
        const ids = new Set(poll.options.map((option) => option.id));
        // Counted per poll rather than over the page, and by person rather than
        // by row: somebody picking three answers in a poll that allows it is one
        // voter, not three.
        const people = new Set(
            votes.filter((cast) => ids.has(cast.optionId)).map((cast) => cast.userId)
        );
        const sealedVotes = takesBallots(poll);
        for (const ballot of ballots) if (ballot.pollId === poll.messageId) people.add(ballot.userId);
        found.set(poll.messageId, {
            multiple: poll.multiple,
            hideResults: poll.hideResults,
            anonymous: poll.anonymous,
            ...(sealedVotes ? { sealedVotes } : {}),
            closed,
            closesAt: poll.closesAt?.toISOString() ?? null,
            endedEarly: poll.closedAt !== null,
            results,
            voters: people.size,
            voted: people.has(viewerId),
            options: poll.options.map((option) => {
                const tally = byOption.get(option.id);
                return {
                    id: option.id,
                    text: option.text,
                    votes: results ? (tally?.count ?? 0) : 0,
                    mine: tally?.mine ?? false
                };
            })
        });
    }

    return found;
}

/**
 * One poll on its own, for a card catching up.
 *
 * A vote changes a message that is already on everybody's screen, and the
 * conversation's own catch-up only ever asks for what was said *after* the last
 * line it holds - so nothing it does would ever bring a new tally back. This is
 * what the card asks instead when the live frame says something happened here.
 *
 * The channel is proved first, like every other read in Chat. Reaching a poll by
 * the id of the message it hangs off must not be a way around the check that
 * drew the conversation.
 */
export async function readPoll(
    actor: { id: string },
    messageId: string
): Promise<ChatPollView | null> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, deletedAt: true }
    });
    if (!message) return null;
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    if (message.deletedAt) return null;
    return (await pollsFor(actor.id, [messageId])).get(messageId) ?? null;
}

/** Who picked one answer of a public poll. */
export interface ChatPollVotersView {
    readonly optionId: string;
    readonly voters: readonly { readonly id: string; readonly name: string }[];
    /** How many picked it past the ones listed. */
    readonly more: number;
}

/**
 * Who picked what, for a poll that was asked in public.
 *
 * Refused outright for an anonymous poll - for the person who asked it and for
 * whoever moderates the room alike - so there is no path from a screen, an
 * action or an export to an anonymous voter's answer. Refused as well while a
 * poll that hides its results is still running: the names under each answer
 * are the results, only spelled out.
 *
 * The access checks are the ones reading the poll asks, in the same order: the
 * message id must not be a way around the check that drew the conversation.
 */
export async function readPollVoters(
    actor: { id: string },
    messageId: string,
    now: Date = new Date()
): Promise<readonly ChatPollVotersView[]> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            deletedAt: true,
            poll: {
                select: {
                    hideResults: true,
                    anonymous: true,
                    closesAt: true,
                    closedAt: true,
                    options: { orderBy: { position: "asc" }, select: { id: true } }
                }
            }
        }
    });
    if (!message?.poll) throw new ChatAccessError({ key: "errors.pollGone" });
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    if (message.deletedAt) throw new ChatRuleError({ key: "errors.pollDeleted" });
    if (message.poll.anonymous) throw new ChatRuleError({ key: "errors.pollAnonymous" });
    if (!core.pollResultsVisible(message.poll, now)) {
        throw new ChatRuleError({ key: "errors.pollVotersHidden" });
    }

    // One bounded read per answer, at most ten, rather than every vote of a
    // poll asked in a room of thousands.
    return Promise.all(
        message.poll.options.map(async (option) => {
            const [rows, total] = await Promise.all([
                prisma.chatPollVote.findMany({
                    where: { optionId: option.id },
                    orderBy: { createdAt: "asc" },
                    take: core.MAX_POLL_VOTERS_LISTED,
                    select: { user: { select: { id: true, name: true } } }
                }),
                prisma.chatPollVote.count({ where: { optionId: option.id } })
            ]);
            return {
                optionId: option.id,
                voters: rows.map((row) => ({ id: row.user.id, name: row.user.name ?? "" })),
                more: Math.max(0, total - rows.length)
            };
        })
    );
}

/**
 * Pick answers, or take a vote back.
 *
 * The whole selection is sent each time rather than one press at a time, so the
 * write is idempotent and the server never has to work out what changed: what
 * arrives is what this person stands behind now, and an empty list is them
 * standing behind nothing.
 *
 * Both halves in one transaction. A vote that cleared the old rows and then
 * failed to write the new ones would look to everybody, the voter included, like
 * a poll that quietly lost somebody.
 */
export async function vote(
    actor: { id: string },
    input: core.ChatPollVoteInput,
    now: Date = new Date()
): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: {
            channelId: true,
            deletedAt: true,
            e2eeEpoch: true,
            poll: {
                select: {
                    multiple: true,
                    closesAt: true,
                    closedAt: true,
                    options: { select: { id: true } }
                }
            }
        }
    });
    if (!message?.poll) throw new ChatAccessError({ key: "errors.pollGone" });
    if (message.deletedAt) throw new ChatRuleError({ key: "errors.pollDeleted" });
    // A sealed poll takes sealed ballots only (`poll-ballots.ts`): a vote in the
    // clear would tell the server the very thing the ballot keeps from it. Only
    // a page from before sealed votes sends one. A plain poll sent before its
    // conversation was sealed takes sealed ballots from then on too.
    if (message.e2eeEpoch != null || (await conversationSealed(message.channelId)))
        throw new ChatRuleError({ key: "errors.sealedOnlyReload" });
    await requirePostable(actor, message.channelId, { reacting: true });
    await history.requireReadable(actor, message.channelId, input.messageId);

    if (core.pollIsClosed(message.poll, now)) throw new ChatRuleError({ key: "errors.pollClosed" });

    const wanted = [...new Set(input.optionIds)];
    if (!message.poll.multiple && wanted.length > 1) {
        throw new ChatRuleError({ key: "errors.pollSingleAnswer" });
    }
    // An answer from another poll, or one that has since gone. Refused rather
    // than dropped: a vote that silently counted for less than was pressed is
    // the one failure a poll must not have.
    const belongs = new Set(message.poll.options.map((option) => option.id));
    if (wanted.some((id) => !belongs.has(id))) {
        throw new ChatAccessError({ key: "errors.pollAnswerInvalid" });
    }

    await prisma.$transaction(async (tx) => {
        await tx.chatPollVote.deleteMany({
            where: { userId: actor.id, optionId: { in: [...belongs] } }
        });
        if (wanted.length > 0) {
            await tx.chatPollVote.createMany({
                data: wanted.map((optionId) => ({ optionId, userId: actor.id }))
            });
        }
    });

    publishChatChange({
        channelId: message.channelId,
        kind: "posted",
        actorId: actor.id,
        messageIds: [input.messageId]
    });
}

/**
 * End a poll before its time.
 *
 * Whoever asked it, and whoever moderates the room. Both, because the two
 * reasons to stop one early are different: the person who asked has the answer
 * they needed already, and the moderator has a poll that should not be running.
 *
 * Doing it twice is not an error. The button sits on a card several people are
 * looking at, and the second press is somebody whose screen had not caught up -
 * an error there would be Polaris telling them off for a race it lost.
 */
export async function endPoll(
    actor: { id: string },
    messageId: string,
    now: Date = new Date()
): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            authorId: true,
            deletedAt: true,
            poll: { select: { closesAt: true, closedAt: true } }
        }
    });
    if (!message?.poll) throw new ChatAccessError({ key: "errors.pollGone" });
    if (message.deletedAt) throw new ChatRuleError({ key: "errors.pollDeleted" });

    const access = await requirePostable(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    if (message.authorId !== actor.id && !access.mayModerate) {
        throw new ChatAccessError({ key: "errors.pollCloseNotYours" });
    }

    if (core.pollIsClosed(message.poll, now)) return;

    await prisma.chatPoll.update({ where: { messageId }, data: { closedAt: now } });
    publishChatChange({
        channelId: message.channelId,
        kind: "posted",
        actorId: actor.id,
        messageIds: [messageId]
    });
}
