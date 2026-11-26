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
 *    epoch (`SWEEP_EPOCH_TOP` down, one per run) and sealed to every member's
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

export type SweepOutcome = "sealed" | "none" | "pending" | "failed" | "off";

const BATCH = 200;
/** Passes over a conversation before what keeps moving is left for the next run. */
const ROUNDS = 5;

/** A person's rows moved under the sweep (the sealed set's or ballot's owner changed them first): tried again. */
class Moved extends Error {}

const copyBody = (copy: AnnotationCopy): string => JSON.stringify(copy);

/** The sweep epoch this run seals under: below the lowest one used, or null once all are used. */
export async function nextSweepEpoch(channelId: string): Promise<bigint | null> {
    const lowest = await prisma.chatHistoryKey.findFirst({ where: { channelId, epoch: sweptEpochs }, orderBy: { epoch: "asc" }, select: { epoch: true } });
    const epoch = lowest ? lowest.epoch - 1n : SWEEP_EPOCH_TOP;
    return epoch >= SWEEP_EPOCH_FLOOR ? epoch : null;
}

/** What one person's clear emoji seal to: each once, the ones a set holds, in the order they were put on. */
export function sealableEmoji(emoji: readonly string[]): string[] {
    const out: string[] = [];
    for (const one of emoji) {
        const bytes = new TextEncoder().encode(one).length;
        if (out.includes(one) || bytes === 0 || bytes > content.REACTION_MAX_BYTES) continue;
        if (out.length >= content.REACTIONS_MAX) break;
        out.push(one);
    }
    return out;
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

/** Sweep one person's clear reactions on one message; false when they cannot be sealed. */
async function sweepReactions(channelId: string, messageId: string, userId: string, historyKey: Uint8Array, epoch: bigint): Promise<boolean> {
    const rows = await prisma.chatReaction.findMany({
        where: { messageId, userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, emoji: true }
    });
    if (!rows.length) return true;
    const replaced = await prisma.chatSealedReaction.findUnique({ where: { messageId_userId: { messageId, userId } }, select: { messageId: true } });
    const emoji = replaced ? [] : sealableEmoji(rows.map((row) => row.emoji));
    const setId = crypto.randomUUID();
    const sealed = emoji.length ? await sealSweptReactions(historyKey, { conversationId: channelId, epoch, messageId, setId, reactor: userId }, emoji) : null;
    if (emoji.length && !sealed) return false;
    if (!replaced && emoji.length < rows.length) console.warn("polaris: a person's clear reactions did not all fit one sealed set; the rest are kept in the rollback copy:", messageId);
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
async function sweepVote(channelId: string, pollId: string, userId: string, historyKey: Uint8Array, epoch: bigint): Promise<boolean> {
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
    const sealed = replaced
        ? null
        : await sealSweptBallot(historyKey, { conversationId: channelId, epoch, pollId, ballotId, voter: poll.anonymous ? null : userId }, picks);
    if (!replaced && !sealed) return false;
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

/** The people with clear reactions in the conversation, a page of (message, person) pairs. */
async function reactionPairs(channelId: string): Promise<{ messageId: string; userId: string }[]> {
    return prisma.chatReaction.findMany({
        where: { message: { channelId } },
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

/** Whether the conversation still has a clear reaction or vote. */
async function hasClear(channelId: string): Promise<boolean> {
    const [reactions, votes] = await Promise.all([
        prisma.chatReaction.count({ where: { message: { channelId } }, take: 1 }),
        prisma.chatPollVote.count({ where: { option: { poll: { message: { channelId } } } }, take: 1 })
    ]);
    return reactions + votes > 0;
}

/**
 * Sweep one conversation (see the header). Answers `sealed`, `none` (not
 * sealed, rolled back, or nothing clear left), `pending` (nobody to seal to
 * yet, or rows that kept moving), `failed` (one did not verify), or `off`.
 */
export async function sweepConversation(channelId: string): Promise<SweepOutcome> {
    if (!chatE2eeEnabled()) return "off";
    if (!(await conversationSealed(channelId))) return "none";
    const migration = await prisma.chatMigration.findUnique({ where: { channelId }, select: { state: true } });
    if (migration?.state === "rolledBack") return "none";
    if (!(await hasClear(channelId))) return "none";

    const audience = await audienceOf(channelId);
    if (!audience?.length) return "pending";
    const epoch = await nextSweepEpoch(channelId);
    if (epoch === null) return "failed";
    const historyKey = content.newHistoryKey();
    try {
        // Sealed to the members before anything is sealed under it: a crash in between leaves envelopes, never unopenable rows.
        if (!(await sealToMembers(channelId, audience, historyKey, epoch))) return "pending";
        for (let round = 0; round < ROUNDS; round++) {
            const reactions = await reactionPairs(channelId);
            const votes = await votePairs(channelId);
            if (!reactions.length && !votes.length) return "sealed";
            const work = [
                ...reactions.map((pair) => () => sweepReactions(channelId, pair.messageId, pair.userId, historyKey, epoch)),
                ...votes.map((pair) => () => sweepVote(channelId, pair.pollId, pair.userId, historyKey, epoch))
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
            if (reactions.length < BATCH && votes.length < BATCH && !(await hasClear(channelId))) return "sealed";
        }
        return "pending";
    } finally {
        historyKey.fill(0);
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
    const counts: Record<SweepOutcome, number> = { sealed: 0, none: 0, pending: 0, failed: 0, off: 0 };
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
