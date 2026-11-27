/**
 * A conversation's member list with who is around, a page at a time.
 *
 * The list is split into Online and Offline (see `roster-groups`). Presence is
 * read here, beside the names, through the same privacy rule the faces use -
 * and only for the page being drawn: a space of a million people is never asked
 * about all at once, and the browser asks for the next page as it scrolls.
 */

import { listChannelMembersPage, type ChatMemberPage } from "./chat-service";
import { presenceFor } from "@/lib/presence-service";
import { isAround, type ChatRosterMember } from "./roster-groups";

export interface ChatRosterPage extends Omit<ChatMemberPage, "members"> {
    readonly members: ChatRosterMember[];
}

export async function listChannelRoster(
    viewer: { id: string; isAdmin: boolean },
    channelId: string,
    after?: string | null
): Promise<ChatRosterPage> {
    const page = await listChannelMembersPage(viewer, channelId, after);
    // One read for the page, which `MEMBER_PAGE` bounds.
    const found =
        page.members.length === 0
            ? new Map()
            : await presenceFor(
                  viewer,
                  page.members.map((member) => member.userId)
              );
    const around = new Set<string>();
    for (const [id, where] of found) if (isAround(where.status)) around.add(id);
    return {
        ...page,
        members: page.members.map((member) => ({ ...member, online: around.has(member.userId) }))
    };
}
