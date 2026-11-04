/**
 * Each person's glossaries and never-translate list, theirs alone.
 *
 * Bounded: nobody keeps more than `GLOSSARIES_MAX` glossaries, a glossary
 * holds no more than `ENTRIES_MAX` terms and the list no more than
 * `KEEP_MAX` words (the input schemas cap both). A pair has at most one
 * default: marking one clears the mark on the others of that pair.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import {
    GLOSSARIES_MAX,
    readEntries,
    readTerms,
    type GlossaryEntry,
    type GlossaryInput
} from "../model/glossary";

/** A glossary as the lists show it: everything but its terms. */
export interface GlossarySummary {
    id: string;
    name: string;
    from: string;
    to: string;
    isDefault: boolean;
    count: number;
    updatedAt: string;
}

export interface Glossary extends GlossarySummary {
    entries: GlossaryEntry[];
}

/** Refused because the person already keeps as many glossaries as they may. */
export class GlossaryLimitError extends Error {
    public constructor() {
        super("glossary limit");
        this.name = "GlossaryLimitError";
    }
}

const FIELDS = {
    id: true,
    name: true,
    fromLang: true,
    toLang: true,
    isDefault: true,
    entries: true,
    updatedAt: true
} as const;

interface Row {
    id: string;
    name: string;
    fromLang: string;
    toLang: string;
    isDefault: boolean;
    entries: unknown;
    updatedAt: Date;
}

function view(row: Row): Glossary {
    const entries = readEntries(row.entries);
    return {
        id: row.id,
        name: row.name,
        from: row.fromLang,
        to: row.toLang,
        isDefault: row.isDefault,
        count: entries.length,
        updatedAt: row.updatedAt.toISOString(),
        entries
    };
}

function summary(row: Row): GlossarySummary {
    const { entries: _entries, ...rest } = view(row);
    return rest;
}

/** Every glossary the person keeps, newest first, without their terms. */
export async function listGlossaries(userId: string): Promise<GlossarySummary[]> {
    const rows = await prisma.translateGlossary.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: GLOSSARIES_MAX,
        select: FIELDS
    });
    return rows.map(summary);
}

/** One of the person's glossaries with its terms, or null when it is not theirs. */
export async function getGlossary(userId: string, id: string): Promise<Glossary | null> {
    const row = await prisma.translateGlossary.findFirst({ where: { id, userId }, select: FIELDS });
    return row ? view(row) : null;
}

/** The pair's other glossaries lose the default mark. */
async function clearDefault(userId: string, input: GlossaryInput, keep: string | null) {
    await prisma.translateGlossary.updateMany({
        where: {
            userId,
            fromLang: input.from,
            toLang: input.to,
            isDefault: true,
            ...(keep ? { id: { not: keep } } : {})
        },
        data: { isDefault: false }
    });
}

/**
 * A new glossary, or one of the person's own changed. Null when `id` names a
 * glossary that is not theirs (or no longer exists).
 */
export async function saveGlossary(
    userId: string,
    id: string | null,
    input: GlossaryInput
): Promise<Glossary | null> {
    const data = {
        name: input.name,
        fromLang: input.from,
        toLang: input.to,
        isDefault: input.isDefault,
        entries: input.entries
    };
    if (id) {
        const changed = await prisma.translateGlossary.updateMany({ where: { id, userId }, data });
        if (changed.count === 0) return null;
        if (input.isDefault) await clearDefault(userId, input, id);
        return getGlossary(userId, id);
    }
    const kept = await prisma.translateGlossary.count({ where: { userId } });
    if (kept >= GLOSSARIES_MAX) throw new GlossaryLimitError();
    if (input.isDefault) await clearDefault(userId, input, null);
    const row = await prisma.translateGlossary.create({
        data: { userId, ...data },
        select: FIELDS
    });
    return view(row);
}

/** Delete one glossary; only its owner's. */
export async function deleteGlossary(userId: string, id: string): Promise<void> {
    await prisma.translateGlossary.deleteMany({ where: { id, userId } });
}

/** The person's never-translate list; empty when they have none. */
export async function getKeepList(userId: string): Promise<string[]> {
    const row = await prisma.translateKeepList.findUnique({
        where: { userId },
        select: { terms: true }
    });
    return readTerms(row?.terms);
}

export async function saveKeepList(userId: string, terms: string[]): Promise<string[]> {
    const row = await prisma.translateKeepList.upsert({
        where: { userId },
        create: { userId, terms },
        update: { terms },
        select: { terms: true }
    });
    return readTerms(row.terms);
}
