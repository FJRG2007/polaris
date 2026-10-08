/**
 * A group's members, a page at a time, and the people who could join it.
 *
 * A group can be everybody a hosting company serves, so its roster is never read
 * whole: the groups screen shows the first page of each and the count, and the
 * group's own dialog reads the rest as it is scrolled. Pages are ordered by the
 * member's id, which the membership's primary key already indexes, and the
 * cursor is that id.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { like } from "@/lib/rich-text/mention-service";
import { pageSize, type Page } from "@/lib/pagination/cursor";

export interface GroupMemberView {
    readonly id: string;
    readonly name: string;
    readonly email: string;
}

/** What a group's row and the first screen of its dialog show. */
export const GROUP_MEMBERS_PAGE = 50;

/** The most people one search offers. */
const CANDIDATES = 20;

/** The fewest characters that count as a search. */
const SHORTEST = 2;

const memberCursorSchema = z.string().uuid();

/** One page of a group's members, after `cursor` (a member's id). */
export async function readGroupMembers(
    groupId: string,
    cursor: string | null = null,
    limit?: number
): Promise<Page<GroupMemberView>> {
    const size = pageSize(limit, GROUP_MEMBERS_PAGE);
    const from = memberCursorSchema.safeParse(cursor);
    const rows = await prisma.groupMember.findMany({
        where: { groupId, ...(from.success ? { userId: { gt: from.data } } : {}) },
        orderBy: { userId: "asc" },
        take: size + 1,
        select: { user: { select: { id: true, name: true, email: true } } }
    });
    const items = rows.slice(0, size).map((row) => row.user);
    return { items, next: rows.length > size ? (items[items.length - 1]?.id ?? null) : null };
}

/** How many of a group's members its row arrives with - a screenful of the
 *  dialog, and more faces than the row shows. */
export const GROUP_PREVIEW = 20;

/** The first page of a roster read with the group: one row past the page says
 *  whether there is another. */
export function firstMembers(rows: readonly { user: GroupMemberView }[]): Page<GroupMemberView> {
    const items = rows.slice(0, GROUP_PREVIEW).map((row) => row.user);
    return { items, next: rows.length > GROUP_PREVIEW ? (items[items.length - 1]?.id ?? null) : null };
}

/** The groups somebody in them is called, for a search by a member's name. */
export async function groupsWithMember(query: string): Promise<string[]> {
    const term = query.trim();
    if (term.length < SHORTEST) return [];
    const contains = like(term);
    const groups = await prisma.group.findMany({
        where: { members: { some: { user: { OR: [{ name: contains }, { email: contains }] } } } },
        select: { id: true },
        take: 200
    });
    return groups.map((group) => group.id);
}

/** People a search found, and whether each is in the group already. */
export async function findGroupCandidates(
    groupId: string,
    query: string
): Promise<{ id: string; name: string; member: boolean }[]> {
    const term = query.trim();
    if (term.length < SHORTEST) return [];
    const contains = like(term);
    const found = await prisma.user.findMany({
        where: { OR: [{ name: contains }, { email: contains }, { username: contains }] },
        select: { id: true, name: true, groups: { where: { groupId }, select: { groupId: true } } },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: CANDIDATES
    });
    return found.map((person) => ({ id: person.id, name: person.name, member: person.groups.length > 0 }));
}
