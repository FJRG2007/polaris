/**
 * Games played together, as the server remembers them - the side of a call's
 * game that somebody outside the call can see.
 *
 * The call's media server carries who is playing and where between browsers
 * (`call-activity`); nothing of that reaches a reader who is not in the call.
 * So the server keeps a short record beside it: the session a call is playing,
 * the card in the call's conversation that offers it, and who has played. It is
 * written by the same actions that mint and renew a pass, after they have
 * checked everything, so it says no more than the call already believes.
 *
 * Every change wakes the card's message on every screen showing it, so the
 * card follows people joining and leaving and ends when the session does.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { activityMark, sessionEnded, stillPlaying } from "./activity-card";

interface SessionRow {
    readonly id: string;
    readonly channelId: string;
    readonly game: string;
    readonly messageId: string | null;
}

const ROW = { id: true, channelId: true, game: true, messageId: true } as const;

/** Wake the card's message on every screen showing it. */
function wake(session: SessionRow, actorId: string): void {
    if (!session.messageId) return;
    publishChatChange({
        channelId: session.channelId,
        kind: "posted",
        actorId,
        messageIds: [session.messageId]
    });
}

/** The conversation a call belongs to, or null for a call that belongs to none
 *  or is over: a meeting with no conversation has nowhere to show a card. */
async function callChannel(meetingId: string): Promise<string | null> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { channelId: true, endedAt: true }
    });
    return meeting && !meeting.endedAt ? meeting.channelId : null;
}

/**
 * The session this call is playing, opened - with its card posted - when there
 * is none. A session of another game is closed first: one game per call, the
 * same rule every browser applies to the claims.
 */
export async function openSession(
    meetingId: string,
    game: string,
    startedById: string,
    now = Date.now()
): Promise<SessionRow | null> {
    const channelId = await callChannel(meetingId);
    if (!channelId) return null;
    const open = await prisma.arcadeSession.findMany({
        where: { meetingId, endedAt: null },
        select: {
            ...ROW,
            createdAt: true,
            endedAt: true,
            players: { select: { userId: true, seenAt: true, leftAt: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 5
    });
    let kept: SessionRow | null = null;
    for (const session of open) {
        const over = sessionEnded({ ...session, callEnded: false }, now);
        if (!kept && session.game === game && !over) {
            kept = session;
            continue;
        }
        await prisma.arcadeSession.update({
            where: { id: session.id },
            data: { endedAt: new Date(now) }
        });
        wake(session, startedById);
    }
    if (kept) return kept;

    const created = await prisma.arcadeSession.create({
        data: { meetingId, channelId, game, startedById },
        select: ROW
    });
    const message = await prisma.chatMessage.create({
        data: { channelId, kind: "system", authorId: null, body: activityMark(created.id) },
        select: { id: true }
    });
    await prisma.arcadeSession.update({
        where: { id: created.id },
        data: { messageId: message.id }
    });
    publishChatChange({ channelId, kind: "posted", actorId: startedById });
    return { ...created, messageId: message.id };
}

/** Somebody started or joined the call's game. Best effort: the game is
 *  played whether or not the card heard of it. */
export async function recordPlay(meetingId: string, userId: string, game: string): Promise<void> {
    try {
        const session = await openSession(meetingId, game, userId);
        if (!session) return;
        const now = new Date();
        await prisma.arcadeSessionPlayer.upsert({
            where: { sessionId_userId: { sessionId: session.id, userId } },
            create: { sessionId: session.id, userId, joinedAt: now, seenAt: now },
            update: { seenAt: now, leftAt: null }
        });
        wake(session, userId);
    } catch (caught) {
        console.error("[arcade] could not record a player", caught);
    }
}

/** A player renewed their pass: still playing. Quiet - the card already
 *  shows them. */
export async function touchPlay(meetingId: string, userId: string, game: string): Promise<void> {
    try {
        await prisma.arcadeSessionPlayer.updateMany({
            where: { userId, session: { meetingId, game, endedAt: null } },
            data: { seenAt: new Date() }
        });
    } catch (caught) {
        console.error("[arcade] could not renew a player", caught);
    }
}

/** A player left the game. The last one out ends the session. */
export async function leavePlay(meetingId: string, userId: string): Promise<void> {
    try {
        const sessions = await prisma.arcadeSession.findMany({
            where: { meetingId, endedAt: null, players: { some: { userId, leftAt: null } } },
            select: ROW,
            take: 5
        });
        const now = new Date();
        for (const session of sessions) {
            await prisma.arcadeSessionPlayer.update({
                where: { sessionId_userId: { sessionId: session.id, userId } },
                data: { leftAt: now }
            });
            const rows = await prisma.arcadeSessionPlayer.findMany({
                where: { sessionId: session.id },
                select: { userId: true, seenAt: true, leftAt: true }
            });
            if (!rows.some((row) => stillPlaying(row, now.getTime()))) {
                await prisma.arcadeSession.update({
                    where: { id: session.id },
                    data: { endedAt: now }
                });
            }
            wake(session, userId);
        }
    } catch (caught) {
        console.error("[arcade] could not record a player leaving", caught);
    }
}

/** Everything the card is read from, or null for no such session. */
export async function sessionForCard(sessionId: string) {
    return prisma.arcadeSession.findUnique({
        where: { id: sessionId },
        select: {
            ...ROW,
            meetingId: true,
            startedById: true,
            createdAt: true,
            endedAt: true,
            players: {
                select: { userId: true, seenAt: true, leftAt: true },
                orderBy: { joinedAt: "asc" },
                take: 64
            }
        }
    });
}
