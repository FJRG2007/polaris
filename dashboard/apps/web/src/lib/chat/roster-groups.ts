/**
 * How a space's member list is laid out: who is around first, everybody else
 * after.
 *
 * A space can hold hundreds of people, and in a list of hundreds sorted by
 * standing the person you are looking for is wherever their role put them. Split
 * into the ones who are here and the ones who are not, the first group is the
 * short one and the one people come to the list for - who could answer now.
 *
 * Away and do-not-disturb count as here: both are somebody at a keyboard who
 * chose how loud to be. Invisible arrives as offline, which is the point of it.
 * Polaris has no role that is listed separately, so there are two sections and
 * the owner and administrators keep their marks inside them.
 *
 * Pure, so it runs in the browser on every presence change and is pinned by a
 * test rather than by looking at the screen.
 */

import type { Presence } from "@polaris/core";
import type { ChatMemberView } from "./chat-service";

export interface ChatRosterMember extends ChatMemberView {
    /** Whether they were around when the list was read. The live answer for a
     *  drawn row replaces it; see `rosterItems`. */
    readonly online: boolean;
}

export type RosterSection = "online" | "offline";

export type RosterItem =
    | {
          readonly kind: "heading";
          readonly key: string;
          readonly section: RosterSection;
          readonly count: number;
      }
    | {
          readonly kind: "member";
          readonly key: string;
          readonly member: ChatRosterMember;
          /** Drawn dimmed. Only ever true in a grouped list. */
          readonly away: boolean;
      };

/** Whether a status counts as being around. */
export function isAround(status: Presence): boolean {
    return status !== "offline";
}

/** Where a role sorts in a list that is not grouped. Lower comes first;
 *  anything unrecognised sorts last rather than crashing the list. */
const RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };

const byName = (left: ChatRosterMember, right: ChatRosterMember): number =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }) ||
    left.userId.localeCompare(right.userId);

/**
 * The rows of a member list, headings included, in the order they are drawn.
 *
 * @param live - What the presence store already knows. Wins over the snapshot
 *   the list arrived with, because it was asked more recently.
 * @param grouped - Split into Online and Offline. A space's list is; a group's
 *   is the handful of people in it, ordered by standing as it always was.
 */
export function rosterItems(
    members: readonly ChatRosterMember[],
    live: ReadonlyMap<string, { readonly status: Presence }>,
    grouped: boolean
): RosterItem[] {
    if (!grouped) {
        return [...members]
            .sort(
                (left, right) =>
                    (RANK[left.role] ?? 9) - (RANK[right.role] ?? 9) || byName(left, right)
            )
            .map((member) => ({ kind: "member", key: member.userId, member, away: false }));
    }

    const around: ChatRosterMember[] = [];
    const gone: ChatRosterMember[] = [];
    for (const member of members) {
        const now = live.get(member.userId);
        (now ? isAround(now.status) : member.online) ? around.push(member) : gone.push(member);
    }

    const items: RosterItem[] = [];
    // An empty section has no heading: "Offline - 0" is a line about nobody.
    for (const [section, people] of [
        ["online", around.sort(byName)],
        ["offline", gone.sort(byName)]
    ] as const) {
        if (people.length === 0) continue;
        items.push({ kind: "heading", key: `@${section}`, section, count: people.length });
        for (const member of people) {
            items.push({ kind: "member", key: member.userId, member, away: section === "offline" });
        }
    }
    return items;
}
