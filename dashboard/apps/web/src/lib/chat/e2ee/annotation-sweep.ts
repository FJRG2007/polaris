/**
 * The sweep of clear reactions and votes left in sealed conversations
 * (docs/chat-e2ee-mls.md, "Sealed reactions"): a reaction or a vote put on
 * before its conversation was sealed stayed in the clear, telling the server
 * who put which emoji on what and who voted for which answer. The server
 * seals them, for the reason the migration seals plain history
 * (`legacy-migration.ts`): it already held them, and the people may never come
 * back to do it from a browser.
 *
 * Per conversation, the way the migration does it:
 *
 * 1. A one-time history key `HK(c, sweep)` is made in memory at a fresh sweep
 *    epoch (`SWEEP_EPOCH_TOP` down, one per run that seals something) and sealed to every member's
 *    account key before anything is sealed under it; nobody with a key yet
 *    leaves the conversation for the next pass.
 * 2. Each person's clear reactions on a message become one sealed set
 *    (`ChatSealedReaction`) and each person's clear vote on a poll one sealed
 *    ballot (`ChatPollBallot`, the voter named on a public poll and not on an
 *    anonymous one) - the same formats and bindings a browser seals, so every
 *    reader opens them with no change.
 * 3. Verification: each one is opened again with `HK` and compared with the
 *    rows it came from before anything is written; a difference leaves the
 *    conversation failed and its clear rows where they are.
 * 4. Cut, per person: the sealed row is written, and the clear rows moved to
 *    `ChatMigrationRollback` (kinds "reaction" and "vote", 30 days) in the same
 *    transaction that deletes them, guarded on them all still being there.
 * 5. `HK` is dropped.
 *
 * Idempotent and rerunnable: a run that stops halfway leaves every person
 * either fully swept or untouched, and the next run seals the rest under a key
 * of its own. A clear row beside a set or ballot that already replaced it (the
 * browser's own straggler path) is copied as superseded and dropped, never
 * sealed in. A rolled-back conversation is left alone, like the migration
 * leaves it.
 */

import { prisma } from "@polaris/db";
import { chatE2eeEnabled } from "./flag";
import { conversationSealed } from "./sealed-conversation";
import * as content from "@polaris/chat-crypto/message-content";
import { SWEEP_EPOCH_FLOOR, SWEEP_EPOCH_TOP } from "./mls-history-keys";
import { audienceOf, backupReady, sealToMembers } from "./legacy-migration";
import { REACTION_COPY, VOTE_COPY, sweptEpochs, type AnnotationCopy } from "./annotation-rollback";

export type SweepOutcome = "sealed" | "kept" | "none" | "pending" | "failed" | "off";

const BATCH = 200;
/** People with a row no set holds one run leaves in the clear before it calls the conversation failed: a bound on the query that skips them. */
const KEPT_MAX = 100;
/** Passes over a conversation before what keeps moving is left for the next run. */
const ROUNDS = 5;

/** A person's rows moved under the sweep (the sealed set's or ballot's owner changed them first): tried again. */
class Moved extends Error {}

/** The run's key could not be made: what the conversation is answered as. */
class Unkeyed extends Error {
    constructor(readonly outcome: SweepOutcome) {
        super(outcome);
    }
}

/** The run's one-time key and its epoch, made the first time something is sealed under it. */
type SweepKey = () => Promise<{ historyKey: Uint8Array; epoch: bigint }>;

const copyBody = (copy: AnnotationCopy): string => JSON.stringify(copy);

/** The sweep epoch this run seals under: below the lowest one used, or null once all are used. */
export async function nextSweepEpoch(channelId: string): Promise<bigint | null> {
    const lowest = await prisma.chatHistoryKey.findFirst({ where: { channelId, epoch: sweptEpochs }, orderBy: { epoch: "asc" }, select: { epoch: true } });
    const epoch = lowest ? lowest.epoch - 1n : SWEEP_EPOCH_TOP;
    return epoch >= SWEEP_EPOCH_FLOOR ? epoch : null;
}

/**
 * What one person's clear emoji on a message seal to: each once, in the order
 * they were put on, all of them, in a set as large as they need - or null for
 * a row no set holds (an empty emoji or one past 255 bytes, which the clear
 * path never stores; `content.reactionsFit`). Never part of them: a set
 * holding some would make the rest disappear once the rollback copy expires.
 */
export function sealableEmoji(emoji: readonly string[]): string[] | null {
    const out = [...new Set(emoji)];
    return content.reactionsFit(out) ? out : null;
}

/** Seal one person's set, opened again and compared; null when it does not open to what it came from. */
export async function sealSweptReactions(historyKey: Uint8Array, binding: content.ReactionsBinding, emoji: readonly string[]): Promise<Uint8Array | null> {
    const sealed = await content.sealReactions(historyKey, binding, content.encodeReactions(emoji));
    const opened = await content.openReactions(historyKey, binding, sealed).catch(() => null);
    const back = opened ? content.decodeReactions(opened) : null;
    return back && JSON.stringify(back) === JSON.stringify(emoji) ? sealed : null;
}

/** Seal one person's ballot, opened again and compared; null when it does not open to what it came from. */
export async function sealSweptBallot(historyKey: Uint8Array, binding: content.BallotBinding, picks: readonly number[]): Promise<Uint8Array | null> {
    const want = [...new Set(picks)].sort((left, right) => left - right);
    const sealed = await content.sealBallot(historyKey, binding, content.encodeBallot(want));
    const opened = await content.openBallot(historyKey, binding, sealed).catch(() => null);
    const back = opened ? content.decodeBallot(opened) : null;
    return back && JSON.stringify(back) === JSON.stringify(want) ? sealed : null;
}

const owned = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

/**
 * Sweep one person's clear reactions on one message: true when swept, false
 * when a set did not verify, "kept" when one of them is a row no set holds
 * (see `sealableEmoji`) - left in the clear, untouched and drawn as before,
 * rather than sealed in part.
 */
async function sweepReactions(channelId: string, messageId: string, userId: string, key: SweepKey): Promise<boolean | "kept"> {
    const rows = await prisma.chatReaction.findMany({
        where: { messageId, userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, emoji: true }
    });
    if (!rows.length) return true;
    const replaced = await prisma.chatSealedReaction.findUnique({ where: { messageId_userId: { messageId, userId } }, select: { messageId: true } });
    const emoji = replaced ? [] : sealableEmoji(rows.map((row) => row.emoji));
    if (!emoji) return "kept";
    const setId = crypto.randomUUID();
    let sealed: Uint8Array | null = null;
    let epoch = 0n;
    if (emoji.length) {
        const held = await key();
        epoch = held.epoch;
        sealed = await sealSweptReactions(held.historyKey, { conversationId: channelId, epoch, messageId, setId, reactor: userId }, emoji);
        if (!sealed) return false;
    }
    await prisma.$transaction(async (tx) => {
        const gone = await tx.chatReaction.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        if (gone.count !== rows.length) throw new Moved();
        await tx.chatMigrationRollback.createMany({
            data: rows.map((row) => ({
                kind: REACTION_COPY,
                id: row.id,
                messageId,
                channelId,
                body: copyBody({ userId, emoji: row.emoji, ...(replaced ? { superseded: true } : {}) })
            })),
            skipDuplicates: true
        });
        // Created, not upserted: a set the person sent meanwhile fails this and the sweep stands back.
        if (sealed) await tx.chatSealedReaction.create({ data: { messageId, userId, setId, epoch, sealed: owned(sealed) } });
    });
    return true;
}

/** Sweep one person's clear vote on one poll; false when it cannot be sealed. */
async function sweepVote(channelId: string, pollId: string, userId: string, key: SweepKey): Promise<boolean> {
    const poll = await prisma.chatPoll.findUnique({
        where: { messageId: pollId },
        select: { anonymous: true, options: { orderBy: { position: "asc" }, select: { id: true } } }
    });
    if (!poll) return true;
    const optionIds = poll.options.map((option) => option.id);
    const rows = await prisma.chatPollVote.findMany({ where: { userId, optionId: { in: optionIds } }, orderBy: { id: "asc" }, select: { id: true, optionId: true } });
    if (!rows.length) return true;
    const replaced = await prisma.chatPollBallot.findUnique({ where: { pollId_userId: { pollId, userId } }, select: { pollId: true } });
    const picks = rows.map((row) => optionIds.indexOf(row.optionId));
    if (picks.some((at) => at < 0 || at >= content.BALLOT_MAX_ANSWERS)) return false;
    const ballotId = crypto.randomUUID();
    let sealed: Uint8Array | null = null;
    let epoch = 0n;
    if (!replaced) {
        const held = await key();
        epoch = held.epoch;
        sealed = await sealSweptBallot(held.historyKey, { conversationId: channelId, epoch, pollId, ballotId, voter: poll.anonymous ? null : userId }, picks);
        if (!sealed) return false;
    }
    await prisma.$transaction(async (tx) => {
        const gone = await tx.chatPollVote.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        if (gone.count !== rows.length) throw new Moved();
        await tx.chatMigrationRollback.createMany({
            data: rows.map((row) => ({
                kind: VOTE_COPY,
                id: row.id,
                messageId: pollId,
                channelId,
                body: copyBody({ userId, optionId: row.optionId, ...(replaced ? { superseded: true } : {}) })
            })),
            skipDuplicates: true
        });
        if (sealed) await tx.chatPollBallot.create({ data: { pollId, userId, ballotId, epoch, sealed: owned(sealed) } });
    });
    return true;
}

/** Whether a person's sweep stood back because they changed their own rows first. */
const stoodBack = (caught: unknown): boolean =>
    caught instanceof Moved || (typeof caught === "object" && caught !== null && (caught as { code?: unknown }).code === "P2002");

type Pair = { messageId: string; userId: string };

/** The clear reactions of a conversation, but for the people left in the clear (`kept`). */
const clearReactions = (channelId: string, kept: readonly Pair[]) => ({ message: { channelId }, ...(kept.length ? { NOT: [...kept] } : {}) });

/** The people with clear reactions in the conversation, a page of (message, person) pairs, but for those kept. */
async function reactionPairs(channelId: string, kept: readonly Pair[]): Promise<Pair[]> {
    return prisma.chatReaction.findMany({
        where: clearReactions(channelId, kept),
        distinct: ["messageId", "userId"],
        orderBy: [{ messageId: "asc" }, { userId: "asc" }],
        select: { messageId: true, userId: true },
        take: BATCH
    });
}

/** The people with a clear vote in the conversation, a page of (poll, person) pairs. */
async function votePairs(channelId: string): Promise<{ pollId: string; userId: string }[]> {
    const rows = await prisma.chatPollVote.findMany({
        where: { option: { poll: { message: { channelId } } } },
        orderBy: { id: "asc" },
        select: { userId: true, option: { select: { pollId: true } } },
        take: BATCH
    });
    const seen = new Map<string, { pollId: string; userId: string }>();
    for (const row of rows) seen.set(`${row.option.pollId}/${row.userId}`, { pollId: row.option.pollId, userId: row.userId });
    return [...seen.values()];
}

/** Whether the conversation still has a clear reaction (but for those kept) or vote. */
async function hasClear(channelId: string, kept: readonly Pair[] = []): Promise<boolean> {
    const [reactions, votes] = await Promise.all([
        prisma.chatReaction.count({ where: clearReactions(channelId, kept), take: 1 }),
        prisma.chatPollVote.count({ where: { option: { poll: { message: { channelId } } } }, take: 1 })
    ]);
    return reactions + votes > 0;
}

/**
 * Sweep one conversation (see the header). Answers `sealed`, `kept` (sealed
 * but for people with a row no set holds, left in the clear), `none` (not sealed, rolled back, or nothing clear left), `pending`
 * (nobody to seal to yet, or rows that kept moving), `failed` (one did not
 * verify), or `off`.
 */
export async function sweepConversation(channelId: string): Promise<SweepOutcome> {
    if (!chatE2eeEnabled()) return "off";
    if (!(await conversationSealed(channelId))) return "none";
    const migration = await prisma.chatMigration.findUnique({ where: { channelId }, select: { state: true } });
    if (migration?.state === "rolledBack") return "none";
    if (!(await hasClear(channelId))) return "none";

    const audience = await audienceOf(channelId);
    if (!audience?.length) return "pending";
    // Made only once something is to be sealed: a run that finds only people left in the clear, or rows
    // already replaced, takes no epoch, so the conversation's thousand are never spent by runs that sealed nothing.
    const holder: { held: { historyKey: Uint8Array; epoch: bigint } | null } = { held: null };
    const key: SweepKey = async () => {
        if (holder.held) return holder.held;
        const epoch = await nextSweepEpoch(channelId);
        if (epoch === null) throw new Unkeyed("failed");
        const historyKey = content.newHistoryKey();
        // Sealed to the members before anything is sealed under it: a crash in between leaves envelopes, never unopenable rows.
        if (!(await sealToMembers(channelId, audience, historyKey, epoch))) {
            historyKey.fill(0);
            throw new Unkeyed("pending");
        }
        holder.held = { historyKey, epoch };
        return holder.held;
    };
    try {
        // People whose emoji on a message do not fit one set: left in the clear, and not read again this run.
        const kept: Pair[] = [];
        const done = (): SweepOutcome => (kept.length ? "kept" : "sealed");
        for (let round = 0; round < ROUNDS; round++) {
            const reactions = await reactionPairs(channelId, kept);
            const votes = await votePairs(channelId);
            if (!reactions.length && !votes.length) return done();
            const work = [
                ...reactions.map((pair) => async () => {
                    const swept = await sweepReactions(channelId, pair.messageId, pair.userId, key);
                    if (swept !== "kept") return swept;
                    if (kept.length >= KEPT_MAX) return false;
                    kept.push(pair);
                    console.warn("polaris: a person's clear reactions on a message do not fit one sealed set and stay in the clear:", pair.messageId);
                    return true;
                }),
                ...votes.map((pair) => () => sweepVote(channelId, pair.pollId, pair.userId, key))
            ];
            for (const step of work) {
                try {
                    if (!(await step())) return "failed";
                } catch (caught) {
                    // They changed it themselves meanwhile: what they did stands, and the next round reads it again.
                    if (!stoodBack(caught)) throw caught;
                }
            }
            // A full page means more to read; a short one swept everything it found.
            if (reactions.length < BATCH && votes.length < BATCH && !(await hasClear(channelId, kept))) return done();
        }
        return "pending";
    } catch (caught) {
        if (caught instanceof Unkeyed) return caught.outcome;
        throw caught;
    } finally {
        holder.held?.historyKey.fill(0);
    }
}

/** Sealed conversations after `after`, a page at a time: those with a group, and those the migration cut. */
async function nextSealed(after: string | null, take: number): Promise<string[]> {
    const where = after ? { channelId: { gt: after } } : {};
    const [groups, cuts] = await Promise.all([
        prisma.mlsGroup.findMany({ where, select: { channelId: true }, orderBy: { channelId: "asc" }, take }),
        prisma.chatMigration.findMany({ where: { ...where, state: "cut" }, select: { channelId: true }, orderBy: { channelId: "asc" }, take })
    ]);
    return [...new Set([...groups, ...cuts].map((row) => row.channelId))].sort().slice(0, take);
}

/**
 * One pass over every sealed conversation, one at a time with a pause between
 * them. Nothing runs while sealed chat is off or there is no recent backup,
 * the migration's own rule, since it deletes clear rows (into the rollback copy).
 */
export async function runAnnotationSweep(options: { pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Record<SweepOutcome, number>> {
    const counts: Record<SweepOutcome, number> = { sealed: 0, kept: 0, none: 0, pending: 0, failed: 0, off: 0 };
    if (!chatE2eeEnabled() || !(await backupReady())) return counts;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let after: string | null = null;
    for (;;) {
        const page = await nextSealed(after, 50);
        if (!page.length) return counts;
        for (const channelId of page) {
            try {
                const outcome = await sweepConversation(channelId);
                counts[outcome]++;
                if (outcome !== "none") await sleep(options.pauseMs ?? 250);
            } catch (caught) {
                counts.failed++;
                console.error("polaris: a sealed conversation's clear reactions and votes could not be sealed:", channelId, caught);
            }
        }
        after = page[page.length - 1]!;
    }
}
