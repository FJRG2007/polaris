/**
 * What happened to something, for any something.
 *
 * Every app in Polaris eventually needs to answer "who changed this, and when?"
 * - a task, a service, a server, a volume - and until now only Tasks could,
 * because the history table had a foreign key to a task. This is that table with
 * the subject named rather than related, and this module is the only thing that
 * writes to it.
 *
 * The rule that comes with going generic: nothing cascades. Whatever deletes a
 * subject calls `forget` for it in the same transaction it does the delete, or
 * the history outlives what it was about. `SUBJECTS` is the list of kinds, so a
 * new one is a line here rather than a string invented at a call site.
 */

import { prisma, type Prisma } from "@polaris/db";

/**
 * Every kind of thing that keeps a history. Adding one is a line here.
 *
 * The words are the schema's, not the interface's: an `app` is what the screens
 * call a service and a `host` is what they call a server. `MetricSample` and
 * `MetricRollup` addressed subjects this way long before these tables did, with
 * exactly this vocabulary, and two answers to "what is an Application called in
 * a subjectType column" is a question somebody would have to ask twice.
 *
 * `user` is here for the follow table alone: following a person is the same
 * relationship as following a service, and a second table for it would be a
 * second set of the same four queries. Nothing writes a history line about a
 * person, and that is a fact about what is written rather than about the
 * vocabulary.
 */
export const SUBJECTS = ["task", "app", "host", "user"] as const;

export type ActivitySubject = (typeof SUBJECTS)[number];

/** One line, with the author already resolved to a name. */
export interface ActivityLine {
    readonly id: string;
    readonly action: string;
    readonly fromValue: string | null;
    readonly toValue: string | null;
    /** Null when nobody did it (a rule, a schedule) or the account is gone. */
    readonly authorName: string | null;
    readonly createdAt: string;
}

/** What a caller hands over to write one line. */
export interface ActivityEntry {
    readonly subjectType: ActivitySubject;
    readonly subjectId: string;
    readonly userId?: string | null;
    readonly action: string;
    readonly fromValue?: string | null;
    readonly toValue?: string | null;
}

const row = (entry: ActivityEntry) => ({
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    userId: entry.userId ?? null,
    action: entry.action,
    fromValue: entry.fromValue ?? null,
    toValue: entry.toValue ?? null
});

/**
 * Record one thing that happened.
 *
 * `client` takes the transaction when the change being recorded is inside one,
 * so a rolled-back change leaves no line saying it happened.
 */
export async function record(entry: ActivityEntry, client: Prisma.TransactionClient = prisma): Promise<void> {
    await client.activity.create({ data: row(entry) });
}

/** The same, for a batch - a bulk edit writes one line per thing it touched. */
export async function recordMany(
    entries: readonly ActivityEntry[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    if (entries.length === 0) return;
    await client.activity.createMany({ data: entries.map(row) });
}

/**
 * The history of one thing, newest first, with author names resolved in one
 * lookup rather than a join - the id is kept without a foreign key precisely so
 * that a line survives the account that wrote it, and a join would drop it.
 */
export async function history(
    subjectType: ActivitySubject,
    subjectId: string,
    limit = 100
): Promise<ActivityLine[]> {
    const lines = await prisma.activity.findMany({
        where: { subjectType, subjectId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, action: true, fromValue: true, toValue: true, userId: true, createdAt: true }
    });
    return withAuthors(lines);
}

/** The history of several things at once, for a screen that lists them. */
export async function historyOfMany(
    subjectType: ActivitySubject,
    subjectIds: readonly string[],
    limit = 100
): Promise<ActivityLine[]> {
    if (subjectIds.length === 0) return [];
    const lines = await prisma.activity.findMany({
        where: { subjectType, subjectId: { in: [...subjectIds] } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, action: true, fromValue: true, toValue: true, userId: true, createdAt: true }
    });
    return withAuthors(lines);
}

/**
 * Drop everything recorded about something. Called by whatever deletes the
 * subject: there is no foreign key to do it, which is the price of one table
 * serving every app.
 */
export async function forget(
    subjectType: ActivitySubject,
    subjectId: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    const ids = typeof subjectId === "string" ? [subjectId] : [...subjectId];
    if (ids.length === 0) return;
    await client.activity.deleteMany({ where: { subjectType, subjectId: { in: ids } } });
}

async function withAuthors(
    lines: readonly {
        id: string;
        action: string;
        fromValue: string | null;
        toValue: string | null;
        userId: string | null;
        createdAt: Date;
    }[]
): Promise<ActivityLine[]> {
    const ids = [...new Set(lines.map((line) => line.userId).filter((id): id is string => id !== null))];
    const authors = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
    const names = new Map(authors.map((author) => [author.id, author.name]));
    return lines.map((line) => ({
        id: line.id,
        action: line.action,
        fromValue: line.fromValue,
        toValue: line.toValue,
        authorName: line.userId ? (names.get(line.userId) ?? null) : null,
        createdAt: line.createdAt.toISOString()
    }));
}
