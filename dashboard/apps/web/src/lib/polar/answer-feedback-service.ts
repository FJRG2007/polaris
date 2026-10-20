/**
 * Good and bad marks on Polar answers: one per answer and person, kept beside
 * the message and gone with it. A mark never changes the answer; it is read
 * back on the answer's row and by the administrator. Server-only.
 */

import { prisma } from "@polaris/db";
import type {
    PolarBadReason,
    PolarFeedbackBody,
    PolarFeedbackRow,
    PolarFeedbackSummary,
    PolarMark,
    PolarRating
} from "@/lib/polar/answer-feedback";

/** Most marks one thread's read returns: more answers than a thread shows. */
const THREAD_MARKS_MOST = 1000;
/** The newest bad marks the administrator's list shows. */
const RECENT_MOST = 50;
const SUMMARY_DAYS = 30;

function markOf(row: { rating: string; reasons: string[]; note: string | null }): PolarMark {
    return {
        rating: row.rating === "good" ? "good" : "bad",
        reasons: row.reasons as PolarBadReason[],
        note: row.note
    };
}

/**
 * Marks an answer in one of this person's chats, or takes the mark back
 * (`rating: null`). Null when the message is not an answer in their chats.
 */
export async function setPolarMark(
    userId: string,
    messageId: string,
    body: PolarFeedbackBody
): Promise<PolarMark | { rating: null } | null> {
    const message = await prisma.polarMessage.findFirst({
        where: { id: messageId, role: "assistant", thread: { userId } },
        select: { metadata: true }
    });
    if (!message) return null;
    if (body.rating === null) {
        await prisma.polarAnswerFeedback.deleteMany({ where: { userId, messageId } });
        return { rating: null };
    }
    const model = (message.metadata as { model?: unknown } | null)?.model;
    const data = {
        rating: body.rating,
        reasons: body.reasons,
        note: body.note,
        model: typeof model === "string" ? model.slice(0, 200) : null
    };
    const row = await prisma.polarAnswerFeedback.upsert({
        where: { userId_messageId: { userId, messageId } },
        create: { userId, messageId, ...data },
        update: data,
        select: { rating: true, reasons: true, note: true }
    });
    return markOf(row);
}

/** This person's marks on the answers of one of their chats, by message id. */
export async function polarMarksOf(
    userId: string,
    threadId: string
): Promise<Record<string, PolarMark>> {
    const rows = await prisma.polarAnswerFeedback.findMany({
        where: { userId, message: { threadId, thread: { userId } } },
        select: { messageId: true, rating: true, reasons: true, note: true },
        take: THREAD_MARKS_MOST
    });
    return Object.fromEntries(rows.map((row) => [row.messageId, markOf(row)]));
}

/**
 * What the administrator reads: the last 30 days' count each way and the
 * newest bad marks with what was said. The answers themselves stay private.
 */
export async function polarFeedbackSummary(now = new Date()): Promise<PolarFeedbackSummary> {
    const since = new Date(now.getTime() - SUMMARY_DAYS * 24 * 60 * 60 * 1000);
    const [counts, recent] = await Promise.all([
        prisma.polarAnswerFeedback.groupBy({
            by: ["rating"],
            where: { createdAt: { gte: since } },
            _count: { _all: true }
        }),
        prisma.polarAnswerFeedback.findMany({
            where: { rating: "bad" },
            select: {
                id: true,
                rating: true,
                reasons: true,
                note: true,
                model: true,
                userId: true,
                createdAt: true,
                user: { select: { name: true, email: true } }
            },
            orderBy: { createdAt: "desc" },
            take: RECENT_MOST
        })
    ]);
    const count = (rating: PolarRating) =>
        counts.find((row) => row.rating === rating)?._count._all ?? 0;
    return {
        good: count("good"),
        bad: count("bad"),
        recent: recent.map(
            (row): PolarFeedbackRow => ({
                id: row.id,
                ...markOf(row),
                model: row.model,
                userId: row.userId,
                name: row.user.name || row.user.email,
                at: row.createdAt.toISOString()
            })
        )
    };
}
