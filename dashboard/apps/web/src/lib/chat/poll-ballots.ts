/**
 * Sealed votes: how a poll in a sealed conversation is voted on
 * (docs/chat-e2ee-mls.md, "Sealed votes").
 *
 * The voter's browser seals which answers they picked under the
 * conversation's history key and hands over the ballot; this module keeps one
 * per voter and never learns what it says. Every member's browser opens the
 * ballots and makes the tally itself. What the server still knows is who has
 * voted and when, which is also what a vote sent as a message in Signal,
 * WhatsApp or Matrix tells their servers.
 *
 * The rules a plain poll has hold the same way: one vote per person (the row
 * is keyed by poll and voter, a new ballot replaces the old one), only while it
 * is open, only for people who may react in the room. A poll that hides its
 * results hands nobody else's ballot out until it closes, and an anonymous
 * poll's ballots are handed out without their voter and in the order of their
 * random ids. What the server cannot check is what a ballot picks: a browser
 * that opens one discards a ballot that picks no answer the poll has, or more
 * than one on a poll that takes one.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import * as history from "./history-visibility";
import { fromText, toText } from "./e2ee/base64url";
import { SEALED_BALLOT_BYTES } from "@polaris/chat-crypto/message-content";
import { ChatAccessError, ChatRuleError, requireChannel, requirePostable } from "./access";

/** Ballots handed out per read; a browser reads on until `next` is null. */
export const BALLOT_PAGE = 1_000;

export const castBallotSchema = z.object({
    messageId: z.string().uuid(),
    /** Null takes the vote back. */
    ballot: z
        .object({
            ballotId: z.string().uuid(),
            epoch: z.string().regex(/^\d{1,19}$/),
            sealed: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64)
        })
        .nullable()
});
export type CastBallotInput = z.infer<typeof castBallotSchema>;

export const readBallotsSchema = z.object({
    messageId: z.string().uuid(),
    /** The last `ballotId` of the page before. */
    after: z.string().uuid().nullable().default(null)
});

export interface BallotView {
    readonly ballotId: string;
    readonly epoch: string;
    readonly sealed: string;
    /** This reader's own ballot. */
    readonly mine: boolean;
    /** Who cast it, on a public poll once its results show; absent otherwise. */
    readonly voter?: { readonly id: string; readonly name: string };
}

export interface BallotsPage {
    readonly ballots: readonly BallotView[];
    readonly next: string | null;
}

/** The poll behind a sealed message, with what every check here needs. */
async function sealedPoll(messageId: string) {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            deletedAt: true,
            e2eeEpoch: true,
            poll: {
                select: {
                    multiple: true,
                    hideResults: true,
                    anonymous: true,
                    closesAt: true,
                    closedAt: true,
                    options: { select: { id: true } }
                }
            }
        }
    });
    if (!message?.poll) throw new ChatAccessError({ key: "errors.pollGone" });
    if (message.deletedAt) throw new ChatRuleError({ key: "errors.pollDeleted" });
    return { ...message, poll: message.poll, sealed: message.e2eeEpoch != null };
}

/** Cast, replace or take back this person's ballot on a sealed poll. */
export async function castBallot(actor: { id: string }, input: CastBallotInput, now: Date = new Date()): Promise<void> {
    const message = await sealedPoll(input.messageId);
    // A plain poll is voted on in the clear, by `polls.vote`.
    if (!message.sealed) throw new ChatRuleError({ key: "errors.voteNotCounted" });
    await requirePostable(actor, message.channelId, { reacting: true });
    await history.requireReadable(actor, message.channelId, input.messageId);
    if (core.pollIsClosed(message.poll, now)) throw new ChatRuleError({ key: "errors.pollClosed" });

    const ballot = input.ballot;
    let sealed: Uint8Array<ArrayBuffer> | null = null;
    let epoch = 0n;
    if (ballot) {
        sealed = new Uint8Array(fromText(ballot.sealed));
        epoch = BigInt(ballot.epoch);
        if (sealed.length !== SEALED_BALLOT_BYTES) throw new ChatRuleError({ key: "errors.voteNotCounted" });
        // An epoch the group has not reached opens for nobody.
        const group = await prisma.mlsGroup.findUnique({ where: { channelId: message.channelId }, select: { epoch: true } });
        if (!group || epoch > group.epoch) throw new ChatRuleError({ key: "errors.voteNotCounted" });
    }

    const optionIds = message.poll.options.map((option) => option.id);
    await prisma.$transaction(async (tx) => {
        // A vote cast in the clear before the poll took sealed ballots goes with the first ballot.
        await tx.chatPollVote.deleteMany({ where: { userId: actor.id, optionId: { in: optionIds } } });
        if (!ballot || !sealed) {
            await tx.chatPollBallot.deleteMany({ where: { pollId: input.messageId, userId: actor.id } });
            return;
        }
        const fields = { ballotId: ballot.ballotId, epoch, sealed, updatedAt: now };
        await tx.chatPollBallot.upsert({
            where: { pollId_userId: { pollId: input.messageId, userId: actor.id } },
            create: { pollId: input.messageId, userId: actor.id, ...fields },
            update: fields
        });
    });

    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id, messageIds: [input.messageId] });
}

/**
 * One page of a sealed poll's ballots for this reader: every ballot once its
 * results show (with the voter on a public poll), only their own before.
 */
export async function readBallots(
    actor: { id: string },
    input: z.infer<typeof readBallotsSchema>,
    now: Date = new Date()
): Promise<BallotsPage> {
    const message = await sealedPoll(input.messageId);
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, input.messageId);
    if (!message.sealed) return { ballots: [], next: null };

    const everyone = core.pollResultsVisible(message.poll, now);
    const named = everyone && !message.poll.anonymous;
    const rows = await prisma.chatPollBallot.findMany({
        where: {
            pollId: input.messageId,
            ...(everyone ? {} : { userId: actor.id }),
            ...(input.after ? { ballotId: { gt: input.after } } : {})
        },
        orderBy: { ballotId: "asc" },
        take: BALLOT_PAGE + 1,
        select: {
            ballotId: true,
            epoch: true,
            sealed: true,
            userId: true,
            ...(named ? { user: { select: { id: true, name: true } } } : {})
        }
    });
    const page = rows.slice(0, BALLOT_PAGE);
    return {
        ballots: page.map((row) => ({
            ballotId: row.ballotId,
            epoch: row.epoch.toString(),
            sealed: toText(row.sealed),
            mine: row.userId === actor.id,
            ...(named && "user" in row && row.user ? { voter: { id: row.user.id, name: row.user.name ?? "" } } : {})
        })),
        next: rows.length > BALLOT_PAGE ? page[page.length - 1]!.ballotId : null
    };
}
