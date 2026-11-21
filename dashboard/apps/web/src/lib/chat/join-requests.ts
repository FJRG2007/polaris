/**
 * A space that asks before it lets people in.
 *
 * Prior art: WhatsApp's "Approve new participants" - joining a group through a
 * link waits for an admin. Here, with `ChatSpace.requireApproval` on, an
 * invitation still works as a credential, but presenting it files a request
 * instead of taking a seat; whoever runs the space accepts or declines it.
 *
 * Off by default, which is how every space admitted people before the switch
 * existed. A ban still stands at the door first, and a request is one per
 * person per space: asking twice is the same request.
 */

import { prisma } from "@polaris/db";
import { chatWordsFor } from "./text";
import { publishChatChange } from "./live";
import { postSpaceNotice } from "./notices";
import { notify } from "@/lib/notifications/dispatch";
import { ChatAccessError, requireSpace, type ChatActor } from "./access";

/** How many waiting requests a queue reads at once. */
export const MOST_JOIN_REQUESTS_LISTED = 200;

/** One request, as the queue draws it. */
export interface JoinRequestView {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly username: string | null;
    readonly createdAt: string;
}

/**
 * File a request to join, from an invitation that was presented. Idempotent:
 * a second press keeps the one request and its place in the queue. The people
 * who run the space hear about the first one only.
 */
export async function requestToJoin(actor: ChatActor, spaceId: string): Promise<void> {
    const existing = await prisma.chatSpaceJoinRequest.findUnique({
        where: { spaceId_userId: { spaceId, userId: actor.id } },
        select: { id: true }
    });
    if (existing) return;
    await prisma.chatSpaceJoinRequest.create({ data: { spaceId, userId: actor.id } });

    const [space, asker, admins] = await Promise.all([
        prisma.chatSpace.findUnique({ where: { id: spaceId }, select: { name: true, ownerId: true } }),
        prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }),
        prisma.chatSpaceMember.findMany({
            where: { spaceId, role: "admin" },
            select: { userId: true },
            take: 50
        })
    ]);
    const told = new Set([...(space ? [space.ownerId] : []), ...admins.map((row) => row.userId)]);
    await Promise.all(
        [...told].map(async (userId) => {
            const words = await chatWordsFor(userId);
            return notify({
                userId,
                event: "chat.joinRequest",
                title: words("joinRequests.notification", {
                    name: asker?.name || words("notices.somebody")
                }),
                body: space?.name || null,
                href: `/chat/s/${spaceId}/requests`
            }).catch(() => undefined);
        })
    );
}

/** Whether this person is waiting on this space, so an invitation they open
 *  again can say so instead of offering to join. */
export async function isWaiting(actor: ChatActor, spaceId: string): Promise<boolean> {
    const row = await prisma.chatSpaceJoinRequest.findUnique({
        where: { spaceId_userId: { spaceId, userId: actor.id } },
        select: { id: true }
    });
    return row !== null;
}

/** The queue and the switch, for whoever runs the space. */
export async function joinRequestsFor(
    actor: ChatActor,
    spaceId: string
): Promise<{ requireApproval: boolean; requests: JoinRequestView[] }> {
    await requireSpace(actor, spaceId, "admin");
    const [space, rows] = await Promise.all([
        prisma.chatSpace.findUnique({ where: { id: spaceId }, select: { requireApproval: true } }),
        prisma.chatSpaceJoinRequest.findMany({
            where: { spaceId },
            orderBy: { createdAt: "asc" },
            take: MOST_JOIN_REQUESTS_LISTED,
            select: {
                id: true,
                userId: true,
                createdAt: true,
                user: { select: { name: true, username: true } }
            }
        })
    ]);
    return {
        requireApproval: space?.requireApproval ?? false,
        requests: rows.map((row) => ({
            id: row.id,
            userId: row.userId,
            name: row.user.name,
            username: row.user.username,
            createdAt: row.createdAt.toISOString()
        }))
    };
}

/** Turn asking on or off. Turning it off leaves anybody already waiting in
 *  the queue, to be answered: nobody is let in by a switch they did not see. */
export async function setRequireApproval(
    actor: ChatActor,
    spaceId: string,
    on: boolean
): Promise<void> {
    await requireSpace(actor, spaceId, "admin");
    await prisma.chatSpace.update({ where: { id: spaceId }, data: { requireApproval: on } });
}

/**
 * Let somebody in, or not. Either way the request is gone; a declined person
 * may ask again with an invitation, the same as WhatsApp. Accepting somebody
 * banned since they asked is refused.
 */
export async function answerJoinRequest(
    actor: ChatActor,
    requestId: string,
    accept: boolean
): Promise<void> {
    const request = await prisma.chatSpaceJoinRequest.findUnique({
        where: { id: requestId },
        select: { id: true, spaceId: true, userId: true }
    });
    if (!request) throw new ChatAccessError({ key: "errors.joinRequestGone" });
    await requireSpace(actor, request.spaceId, "admin");

    // Claimed by deleting it, so two people answering the same request at once
    // do not both act on it.
    const claimed = await prisma.chatSpaceJoinRequest.deleteMany({ where: { id: request.id } });
    if (claimed.count === 0) throw new ChatAccessError({ key: "errors.joinRequestGone" });
    if (!accept) return;

    const barred = await prisma.chatSpaceBan.findUnique({
        where: { spaceId_userId: { spaceId: request.spaceId, userId: request.userId } },
        select: { id: true }
    });
    if (barred) throw new ChatAccessError({ key: "errors.spaceJoinNotAllowed" });

    const already = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: request.spaceId, userId: request.userId } },
        select: { id: true }
    });
    if (already) return;
    await prisma.chatSpaceMember.create({
        data: { spaceId: request.spaceId, userId: request.userId, role: "member" }
    });
    await postSpaceNotice(request.spaceId, "joined", { subjectId: request.userId });
    publishChatChange({ channelId: "", kind: "channels", actorId: "", audience: [request.userId] });
}
