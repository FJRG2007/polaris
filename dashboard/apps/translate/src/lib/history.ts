/**
 * Each person's recent translations, theirs alone.
 *
 * Bounded: every write keeps the newest `HISTORY_MAX` and drops the rest, so
 * the table never grows with use. A translation that grows while somebody is
 * still typing it replaces the entry it started as, instead of leaving one row
 * per pause.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HISTORY_MAX, type RememberInput } from "../model/schemas";

/** How many entries the screen shows. */
export const HISTORY_PAGE = 50;

/** How long after the last write a growing text still counts as the same one. */
const SAME_TEXT_MS = 2 * 60 * 1000;

export interface HistoryEntry {
    id: string;
    sourceText: string;
    targetText: string;
    fromLang: string;
    toLang: string;
    engine: string;
    createdAt: string;
}

const FIELDS = {
    id: true,
    sourceText: true,
    targetText: true,
    fromLang: true,
    toLang: true,
    engine: true,
    createdAt: true,
    updatedAt: true
} as const;

type Row = HistoryEntry & { createdAt: Date; updatedAt: Date };

function view(row: Omit<Row, "createdAt"> & { createdAt: Date }): HistoryEntry {
    return {
        id: row.id,
        sourceText: row.sourceText,
        targetText: row.targetText,
        fromLang: row.fromLang,
        toLang: row.toLang,
        engine: row.engine,
        createdAt: row.createdAt.toISOString()
    };
}

/** Whether `next` is the same text as `last`, still being written. */
export function continues(
    last: { sourceText: string; fromLang: string; toLang: string; updatedAt: Date },
    next: RememberInput,
    now = Date.now()
): boolean {
    if (now - last.updatedAt.getTime() > SAME_TEXT_MS) return false;
    if (last.fromLang !== next.from || last.toLang !== next.to) return false;
    return next.sourceText.startsWith(last.sourceText) || last.sourceText.startsWith(next.sourceText);
}

export async function listHistory(userId: string): Promise<HistoryEntry[]> {
    const rows = await prisma.translateHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: HISTORY_PAGE,
        select: FIELDS
    });
    return rows.map(view);
}

/** Keep one translation, then drop whatever is past the bound. */
export async function remember(userId: string, input: RememberInput): Promise<HistoryEntry> {
    const last = await prisma.translateHistory.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: FIELDS
    });
    const data = {
        sourceText: input.sourceText,
        targetText: input.targetText,
        fromLang: input.from,
        toLang: input.to,
        engine: input.engine
    };
    if (last && last.sourceText === input.sourceText && last.targetText === input.targetText) {
        return view(last);
    }
    const saved =
        last && continues(last, input)
            ? await prisma.translateHistory.update({
                  where: { id: last.id },
                  data,
                  select: FIELDS
              })
            : await prisma.translateHistory.create({ data: { userId, ...data }, select: FIELDS });
    await trim(userId);
    return view(saved);
}

/** Drop everything past the newest `HISTORY_MAX`. */
async function trim(userId: string): Promise<void> {
    const past = await prisma.translateHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: HISTORY_MAX,
        take: 500,
        select: { id: true }
    });
    if (past.length === 0) return;
    await prisma.translateHistory.deleteMany({
        where: { userId, id: { in: past.map((row) => row.id) } }
    });
}

/** Forget one entry; only its owner's. */
export async function forget(userId: string, id: string): Promise<void> {
    await prisma.translateHistory.deleteMany({ where: { id, userId } });
}

export async function forgetAll(userId: string): Promise<void> {
    await prisma.translateHistory.deleteMany({ where: { userId } });
}
