/**
 * What one person calls another.
 *
 * Theirs alone. Somebody whose display name is a handle nobody recognises is
 * "Dad" in one reader's Polaris and unchanged in everybody else's - which is the
 * whole point, and the reason this is a table rather than a field on the account.
 *
 * Where it applies is a judgement rather than a sweep: it replaces the name
 * where Polaris is showing a reader their own list of people - a conversation,
 * the message somebody wrote in it, a roster they are looking at. It must not
 * replace it where the name is a claim about who somebody is: an audit entry, a
 * moderation queue, an invitation, an address. A nickname is a note the namer
 * keeps, and putting it where somebody else reads it as identity is how a record
 * stops being one.
 */

import { prisma } from "@polaris/db";

/** As long as a display name, and no longer: this is a name, not a note. */
export const MAX_NICKNAME = 60;

/**
 * The names this reader has given, for the people asked about.
 *
 * One query for a page rather than one per row: a conversation list is thirty
 * names and a message list is fifty, and neither can afford a lookup each.
 * Absent ids simply are not in the map, which is what "no nickname" is.
 */
export async function nicknamesFor(
    ownerId: string,
    subjectIds: readonly string[]
): Promise<Map<string, string>> {
    const wanted = [...new Set(subjectIds.filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const rows = await prisma.contactName.findMany({
        where: { ownerId, subjectId: { in: wanted } },
        select: { subjectId: true, nickname: true }
    });
    return new Map(rows.map((row) => [row.subjectId, row.nickname]));
}

/** What this reader calls one person, or null. */
export async function nicknameFor(ownerId: string, subjectId: string): Promise<string | null> {
    const row = await prisma.contactName.findUnique({
        where: { ownerId_subjectId: { ownerId, subjectId } },
        select: { nickname: true }
    });
    return row?.nickname ?? null;
}

/**
 * Give somebody a name, or take it back off.
 *
 * Trimmed, and an empty one is a removal rather than a stored blank: a nickname
 * of nothing would draw a person with no name at all.
 *
 * Nobody is told. That is not an oversight - a nickname visible to the person
 * named is a nickname nobody would set, and half of what makes this useful is
 * that it is nobody else's business.
 */
export async function setNickname(
    ownerId: string,
    subjectId: string,
    nickname: string
): Promise<void> {
    if (ownerId === subjectId) return;
    const wanted = nickname.trim().slice(0, MAX_NICKNAME);

    if (!wanted) {
        await prisma.contactName.deleteMany({ where: { ownerId, subjectId } });
        return;
    }
    await prisma.contactName.upsert({
        where: { ownerId_subjectId: { ownerId, subjectId } },
        create: { ownerId, subjectId, nickname: wanted },
        update: { nickname: wanted }
    });
}

/** One name as this reader sees it. The helper exists so the fallback is written
 *  once: a missing nickname is the real name, never an empty string. */
export function asNamed(
    names: Map<string, string>,
    id: string | null | undefined,
    actual: string | null
): string | null {
    if (!id) return actual;
    return names.get(id) ?? actual;
}
