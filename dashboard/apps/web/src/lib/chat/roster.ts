/**
 * A conversation's member list with who is around, read in one go.
 *
 * The list is split into Online and Offline (see `roster-groups`), and the
 * counts in those headings are about everybody, not only the rows on screen. So
 * presence is read here, beside the names, through the same privacy rule the
 * faces use - rather than the browser asking about every member a second time.
 */

import { listChannelMembers } from "./chat-service";
import { presenceFor } from "@/lib/presence-service";
import { isAround, type ChatRosterMember } from "./roster-groups";

/** How many people one presence read covers. Keeps each of its lookups to a
 *  bounded list on a space with thousands in it. */
const BATCH = 500;

export async function listChannelRoster(
    viewer: { id: string; isAdmin: boolean },
    channelId: string
): Promise<ChatRosterMember[]> {
    const members = await listChannelMembers(viewer, channelId);
    const batches: string[][] = [];
    for (let start = 0; start < members.length; start += BATCH) {
        batches.push(members.slice(start, start + BATCH).map((member) => member.userId));
    }
    const around = new Set<string>();
    for (const found of await Promise.all(batches.map((ids) => presenceFor(viewer, ids)))) {
        for (const [id, where] of found) if (isAround(where.status)) around.add(id);
    }
    return members.map((member) => ({ ...member, online: around.has(member.userId) }));
}
