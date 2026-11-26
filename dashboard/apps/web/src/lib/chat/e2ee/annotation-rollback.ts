/**
 * Putting back the clear reactions and votes the annotation sweep sealed
 * (`annotation-sweep.ts`), from their 30-day copies in `ChatMigrationRollback`
 * (kinds "reaction" and "vote"), when a migrated conversation is rolled back
 * (`rollBackConversation`). On its own so the migration can call it without
 * importing the sweep, which imports the migration.
 *
 * A person's swept set or ballot is replaced by their clear rows only while it
 * is still the sweep's (sealed at a sweep epoch): one they changed since,
 * sealed at their group's epoch or taken off, is what they say now, so it
 * stays and its copies are kept until the purge (`kept`). A copy marked
 * `superseded` was a clear row beside a set or ballot that already replaced
 * it; it is never put back. Repeatable: a restored person's copies are gone.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { SWEEP_EPOCH_FLOOR, SWEEP_EPOCH_TOP } from "./mls-history-keys";

/** The epochs a swept set or ballot carries. */
export const sweptEpochs = { gte: SWEEP_EPOCH_FLOOR, lte: SWEEP_EPOCH_TOP };
export const isSweptEpoch = (epoch: bigint): boolean => epoch >= SWEEP_EPOCH_FLOOR && epoch <= SWEEP_EPOCH_TOP;

export const REACTION_COPY = "reaction";
export const VOTE_COPY = "vote";
const BATCH = 200;

/** What a copy's body holds: the person, and the emoji or the answer; `superseded` when it is never put back. */
export const annotationCopySchema = z.union([
    z.object({ userId: z.string().uuid(), emoji: z.string().min(1).max(1_000), superseded: z.boolean().optional() }).strict(),
    z.object({ userId: z.string().uuid(), optionId: z.string().uuid(), superseded: z.boolean().optional() }).strict()
]);
export type AnnotationCopy = z.infer<typeof annotationCopySchema>;

type Copy = { id: string; kind: string; body: string };

/** A copy's body read back, or null for one that is not a copy this module wrote. */
function parsed(copy: Copy): AnnotationCopy | null {
    try {
        const result = annotationCopySchema.safeParse(JSON.parse(copy.body));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

/** One person's copies of one kind on one message. */
function grouped(copies: readonly Copy[]): Map<string, { kind: string; userId: string; rows: { id: string; copy: AnnotationCopy }[] }> {
    const out = new Map<string, { kind: string; userId: string; rows: { id: string; copy: AnnotationCopy }[] }>();
    for (const copy of copies) {
        const body = parsed(copy);
        if (!body || body.superseded) continue;
        const key = `${copy.kind}/${body.userId}`;
        const group = out.get(key) ?? { kind: copy.kind, userId: body.userId, rows: [] };
        group.rows.push({ id: copy.id, copy: body });
        out.set(key, group);
    }
    return out;
}

/** Put one person's swept reactions on a message back in the clear; false when their set moved on. */
async function restoreReactions(messageId: string, userId: string, rows: { id: string; copy: AnnotationCopy }[]): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const swept = await tx.chatSealedReaction.deleteMany({ where: { messageId, userId, epoch: sweptEpochs } });
        if (!swept.count) return false;
        const data = rows.flatMap(({ id, copy }) => ("emoji" in copy ? [{ id, messageId, userId, emoji: copy.emoji }] : []));
        if (data.length) await tx.chatReaction.createMany({ data, skipDuplicates: true });
        await tx.chatMigrationRollback.deleteMany({ where: { kind: REACTION_COPY, id: { in: rows.map((row) => row.id) } } });
        return true;
    });
}

/** Put one person's swept vote on a poll back in the clear; false when their ballot moved on. */
async function restoreVotes(pollId: string, userId: string, rows: { id: string; copy: AnnotationCopy }[]): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const swept = await tx.chatPollBallot.deleteMany({ where: { pollId, userId, epoch: sweptEpochs } });
        if (!swept.count) return false;
        const wanted = rows.flatMap(({ id, copy }) => ("optionId" in copy ? [{ id, optionId: copy.optionId, userId }] : []));
        // An answer removed since has nothing to be voted for.
        const live = new Set(
            (await tx.chatPollOption.findMany({ where: { pollId, id: { in: wanted.map((vote) => vote.optionId) } }, select: { id: true } })).map((option) => option.id)
        );
        const data = wanted.filter((vote) => live.has(vote.optionId));
        if (data.length) await tx.chatPollVote.createMany({ data, skipDuplicates: true });
        await tx.chatMigrationRollback.deleteMany({ where: { kind: VOTE_COPY, id: { in: rows.map((row) => row.id) } } });
        return true;
    });
}

/**
 * Put back every swept reaction and vote of a conversation whose set or
 * ballot is still the sweep's; the sweep's key envelopes go once nothing
 * sealed under them is left.
 */
export async function restoreAnnotations(channelId: string): Promise<{ restored: number; kept: number }> {
    let restored = 0;
    let kept = 0;
    let after: string | null = null;
    for (;;) {
        const page: { messageId: string }[] = await prisma.chatMigrationRollback.findMany({
            where: { channelId, kind: { in: [REACTION_COPY, VOTE_COPY] }, ...(after ? { messageId: { gt: after } } : {}) },
            distinct: ["messageId"],
            select: { messageId: true },
            orderBy: { messageId: "asc" },
            take: BATCH
        });
        if (!page.length) break;
        after = page[page.length - 1]!.messageId;
        for (const { messageId } of page) {
            const copies = await prisma.chatMigrationRollback.findMany({
                where: { channelId, messageId, kind: { in: [REACTION_COPY, VOTE_COPY] } },
                select: { id: true, kind: true, body: true }
            });
            for (const group of grouped(copies).values()) {
                const done =
                    group.kind === REACTION_COPY
                        ? await restoreReactions(messageId, group.userId, group.rows)
                        : await restoreVotes(messageId, group.userId, group.rows);
                if (done) restored++;
                else kept++;
            }
        }
    }
    const [sets, ballots] = await Promise.all([
        prisma.chatSealedReaction.count({ where: { epoch: sweptEpochs, message: { channelId } }, take: 1 }),
        prisma.chatPollBallot.count({ where: { epoch: sweptEpochs, poll: { message: { channelId } } }, take: 1 })
    ]);
    if (!sets && !ballots) await prisma.chatHistoryKey.deleteMany({ where: { channelId, epoch: sweptEpochs } });
    return { restored, kept };
}
