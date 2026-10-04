/**
 * Who one account may put into a group conversation.
 *
 * A group is a room somebody assembles out of people they choose, and choosing
 * somebody puts them in front of everybody else in it - their name, their photo,
 * a notice saying they were added. A one-to-one conversation is different: it is
 * one person writing to one other, who can ignore it or block it, and that stays
 * open to anybody who has the chat and has not blocked either way.
 *
 * So the rule for a group is narrower than the rule for a direct message:
 *
 * - **A friend** - an accepted friendship, never a request still waiting.
 * - **A colleague counts as a friend**, as it does for who may ring you and who
 *   may send you a file (`colleaguesAmong`): being put in the same organization
 *   is somebody with authority over both accounts saying they work together, and
 *   an organization's own chat would be unusable if every group in it needed a
 *   round of friend requests first.
 * - **A block in either direction refuses**, whatever else is true, with the
 *   same vague sentence every other block gives.
 *
 * Only the people being ADDED are asked about. Somebody already in a group stays
 * in it whatever their standing with whoever adds the next person - removing
 * anybody because the rule changed would be the product turning people out of
 * conversations they were put in legitimately. And when a call in a one-to-one
 * grows into a group, the person on the other end of that conversation is not
 * being added by anybody: they were already talking.
 *
 * No administrator exception. Like a friend request, this is about putting
 * something on another person's screen, not about reading, and an administrator
 * who could walk through it would make it a rule with a door in it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { colleaguesAmong } from "@/lib/privacy-service";
import { ChatAccessError, type ChatActor } from "./access";

/**
 * Where one person stands, as far as being added to a group goes.
 *
 * `friend` and `colleague` may be added. The other three may not, and are told
 * apart only so the picker can say the right thing - the server's refusal never
 * names which block it was.
 */
export type GroupStanding = "friend" | "colleague" | "pending" | "stranger" | "blocked";

/** Whether a standing lets somebody be put in a group. */
export function mayJoinGroup(standing: GroupStanding): boolean {
    return standing === "friend" || standing === "colleague";
}

/**
 * Where each of these people stands with the actor.
 *
 * Three reads at most, whatever the number of people: the blocks, the
 * friendships between the actor and exactly these accounts, and the
 * organizations - the last only for whoever is not already a friend.
 */
export async function groupStandings(
    actorId: string,
    candidateIds: readonly string[]
): Promise<Map<string, GroupStanding>> {
    const wanted = [...new Set(candidateIds)].filter((id) => id !== actorId);
    const standings = new Map<string, GroupStanding>();
    if (wanted.length === 0) return standings;

    const [blocked, rows] = await Promise.all([
        blockedBetween(actorId, wanted),
        prisma.friendship.findMany({
            where: {
                OR: [
                    { requesterId: actorId, addresseeId: { in: wanted } },
                    { addresseeId: actorId, requesterId: { in: wanted } }
                ]
            },
            select: { requesterId: true, addresseeId: true, status: true }
        })
    ]);

    const relation = new Map<string, string>();
    for (const row of rows) {
        const other = row.requesterId === actorId ? row.addresseeId : row.requesterId;
        // An accepted row wins over anything else that names the pair.
        if (relation.get(other) !== "accepted") relation.set(other, row.status);
    }

    const undecided = wanted.filter((id) => !blocked.has(id) && relation.get(id) !== "accepted");
    const colleagues = undecided.length > 0 ? await colleaguesAmong(actorId, undecided) : new Set();

    for (const id of wanted) {
        if (blocked.has(id)) standings.set(id, "blocked");
        else if (relation.get(id) === "accepted") standings.set(id, "friend");
        else if (colleagues.has(id)) standings.set(id, "colleague");
        else if (relation.get(id) === "pending") standings.set(id, "pending");
        else standings.set(id, "stranger");
    }
    return standings;
}

/**
 * Refuse unless every one of these people may be put in a group by the actor.
 *
 * A block refuses with the sentence every block gives and names nobody. Anybody
 * else refused is named - the actor picked them, so their name tells the actor
 * nothing new - with how many more there are, so the screen can say what to do.
 */
export async function refuseGroupStrangers(
    actor: ChatActor,
    candidateIds: readonly string[]
): Promise<void> {
    const standings = await groupStandings(actor.id, candidateIds);
    const refused = [...standings].filter(([, standing]) => !mayJoinGroup(standing));
    if (refused.length === 0) return;

    if (refused.some(([, standing]) => standing === "blocked")) {
        throw new ChatAccessError({ key: "errors.cannotStartConversation" });
    }

    const first = await prisma.user.findUnique({
        where: { id: refused[0]![0] },
        select: { name: true, username: true }
    });
    const name = first?.name || (first?.username ? `@${first.username}` : "");
    throw new GroupStrangerError(name, refused.length - 1);
}

/**
 * A group refused because somebody in it is not the actor's friend.
 *
 * A subclass so a caller can tell it from every other refusal without reading
 * the sentence; every caller that only shows the sentence treats it as the
 * `ChatAccessError` it is.
 */
export class GroupStrangerError extends ChatAccessError {
    constructor(name: string, others: number) {
        super({ key: "errors.groupNotFriends", params: { name, others } });
        this.name = "GroupStrangerError";
    }
}
