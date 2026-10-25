/**
 * Games played together, as the server remembers them - the side of a game
 * that somebody outside it can see.
 *
 * A session is played in one of two places:
 *
 * - **In a call**, started from the call's Activities button. The call's media
 *   server carries who is playing and where (`call-activity`), and leaving the
 *   call is leaving the game. This is the only path that uses a call.
 * - **In a lobby**, started by inviting somebody (`meetingId` null). The same
 *   claims and positions travel through a data-only room of its own - nobody
 *   publishes a microphone or a camera, no call starts, nothing rings - the way
 *   a game launcher invites. Leaving a call never touches a lobby, because a
 *   lobby never had one.
 *
 * Either way the server keeps a short record beside it: the session, the card
 * in the conversation that offers it, who has played, and who was invited. It
 * is written by the same actions that mint and renew a pass, after they have
 * checked everything, so it says no more than the game already believes.
 *
 * Every change wakes the card's message on every screen showing it, so the
 * card follows people joining and leaving and ends when the session does.
 *
 * Server-only.
 */

import { publishChatChange } from "./live";
import { prisma, type Prisma } from "@polaris/db";
import { activityMark, INVITE_TTL_MS, sessionEnded, stillPlaying } from "./activity-card";

export interface SessionRow {
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

/** A session with its card posted in the conversation, in one transaction. */
async function createWithCard(
    tx: Prisma.TransactionClient,
    data: { meetingId: string | null; channelId: string; game: string; startedById: string }
): Promise<SessionRow> {
    const created = await tx.arcadeSession.create({ data, select: ROW });
    const message = await tx.chatMessage.create({
        data: {
            channelId: data.channelId,
            kind: "system",
            authorId: null,
            body: activityMark(created.id)
        },
        select: { id: true }
    });
    await tx.arcadeSession.update({ where: { id: created.id }, data: { messageId: message.id } });
    return { ...created, messageId: message.id };
}

/**
 * The session this call is playing, opened - with its card posted - when there
 * is none. A session of another game is closed first: one game per call, the
 * same rule every browser applies to the claims. Two people starting the call's
 * game at once take turns, so the second finds the first one's session instead
 * of posting a second card.
 */
export async function openSession(
    meetingId: string,
    game: string,
    startedById: string,
    now = Date.now()
): Promise<SessionRow | null> {
    const channelId = await callChannel(meetingId);
    if (!channelId) return null;
    const { kept, closed, posted } = await prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`polaris.arcade.session:${meetingId}`}))`;
            const open = await tx.arcadeSession.findMany({
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
            const closed: SessionRow[] = [];
            for (const session of open) {
                const over = sessionEnded({ ...session, callEnded: false }, now);
                if (!kept && session.game === game && !over) {
                    kept = session;
                    continue;
                }
                await tx.arcadeSession.update({
                    where: { id: session.id },
                    data: { endedAt: new Date(now) }
                });
                closed.push(session);
            }
            if (kept) return { kept, closed, posted: false };
            const created = await createWithCard(tx, { meetingId, channelId, game, startedById });
            return { kept: created, closed, posted: true };
        },
        { timeout: 15_000 }
    );
    for (const session of closed) wake(session, startedById);
    if (posted) publishChatChange({ channelId, kind: "posted", actorId: startedById });
    return kept;
}

/**
 * A lobby: a session of `game` with no call, its card posted in the
 * conversation the invitation went to. Nothing rings and no call starts - the
 * people invited are told by their toast, their bell and the card.
 */
export async function openLobby(
    channelId: string,
    game: string,
    startedById: string
): Promise<SessionRow> {
    const created = await prisma.$transaction(
        (tx) => createWithCard(tx, { meetingId: null, channelId, game, startedById }),
        { timeout: 15_000 }
    );
    publishChatChange({ channelId, kind: "posted", actorId: startedById });
    return created;
}

/** Seat somebody in a session's record and wake its card. */
async function seat(session: SessionRow, userId: string): Promise<void> {
    const now = new Date();
    await prisma.arcadeSessionPlayer.upsert({
        where: { sessionId_userId: { sessionId: session.id, userId } },
        create: { sessionId: session.id, userId, joinedAt: now, seenAt: now },
        update: { seenAt: now, leftAt: null }
    });
    wake(session, userId);
}

/** Somebody started or joined the call's game. Best effort: the game is
 *  played whether or not the card heard of it. */
export async function recordPlay(meetingId: string, userId: string, game: string): Promise<void> {
    try {
        const session = await openSession(meetingId, game, userId);
        if (session) await seat(session, userId);
    } catch (caught) {
        console.error("[arcade] could not record a player", caught);
    }
}

/** Somebody joined a lobby. Whether they may was decided by the caller. */
export async function recordLobbyPlay(sessionId: string, userId: string): Promise<void> {
    try {
        const session = await prisma.arcadeSession.findFirst({
            where: { id: sessionId, meetingId: null, endedAt: null },
            select: ROW
        });
        if (session) await seat(session, userId);
    } catch (caught) {
        console.error("[arcade] could not record a lobby player", caught);
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

/** A lobby player renewed their pass. */
export async function touchLobbyPlay(sessionId: string, userId: string): Promise<void> {
    try {
        await prisma.arcadeSessionPlayer.updateMany({
            where: { userId, sessionId, session: { meetingId: null, endedAt: null } },
            data: { seenAt: new Date() }
        });
    } catch (caught) {
        console.error("[arcade] could not renew a lobby player", caught);
    }
}

/** A player left the call's game. The last one out ends the session. */
export async function leavePlay(meetingId: string, userId: string): Promise<void> {
    await leaveWhere({ meetingId }, userId);
}

/** A player left a lobby. The last one out ends it. */
export async function leaveLobbyPlay(sessionId: string, userId: string): Promise<void> {
    await leaveWhere({ id: sessionId, meetingId: null }, userId);
}

async function leaveWhere(where: Prisma.ArcadeSessionWhereInput, userId: string): Promise<void> {
    try {
        const sessions = await prisma.arcadeSession.findMany({
            where: { ...where, endedAt: null, players: { some: { userId, leftAt: null } } },
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
                select: { userId: true, joinedAt: true, seenAt: true, leftAt: true },
                orderBy: { joinedAt: "asc" },
                take: 64
            }
        }
    });
}

/**
 * Invite people to a session: one statement for all of them, and inviting
 * somebody again offers it afresh (a declined or expired invitation comes
 * back). Each invitee's toast is woken by a `game-invite` frame addressed to
 * them alone.
 */
export async function inviteTo(
    session: { readonly id: string; readonly channelId: string },
    inviterId: string,
    userIds: readonly string[],
    now = Date.now()
): Promise<void> {
    const ids = [...new Set(userIds)].filter((id) => id !== inviterId);
    if (ids.length === 0) return;
    const expires = new Date(now + INVITE_TTL_MS);
    await prisma.$executeRaw`
        INSERT INTO "ArcadeInvite" ("sessionId", "userId", "invitedById", "expiresAt")
        SELECT ${session.id}::uuid, invitee, ${inviterId}::uuid, ${expires}
        FROM unnest(${ids}::uuid[]) AS invitee
        ON CONFLICT ("sessionId", "userId") DO UPDATE SET
            "invitedById" = EXCLUDED."invitedById",
            "expiresAt" = EXCLUDED."expiresAt",
            "declinedAt" = NULL,
            "createdAt" = CURRENT_TIMESTAMP`;
    publishChatChange({
        channelId: session.channelId,
        kind: "game-invite",
        actorId: inviterId,
        audience: ids,
        sessionId: session.id
    });
}

/** Whether this person holds an invitation to this session that is still
 *  offered. Says nothing about the session itself: the caller checks that. */
export async function holdsInvite(
    sessionId: string,
    userId: string,
    now = Date.now()
): Promise<boolean> {
    const found = await prisma.arcadeInvite.findFirst({
        where: { sessionId, userId, declinedAt: null, expiresAt: { gt: new Date(now) } },
        select: { sessionId: true }
    });
    return found !== null;
}

/** The invitations still offered to this person, newest first, each with what
 *  its session needs to be judged over or not. */
export async function openInvites(userId: string, now = Date.now()) {
    return prisma.arcadeInvite.findMany({
        where: {
            userId,
            declinedAt: null,
            expiresAt: { gt: new Date(now) },
            session: { endedAt: null }
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
            invitedById: true,
            expiresAt: true,
            declinedAt: true,
            session: {
                select: {
                    id: true,
                    meetingId: true,
                    channelId: true,
                    game: true,
                    createdAt: true,
                    endedAt: true,
                    players: { select: { userId: true, seenAt: true, leftAt: true }, take: 64 }
                }
            }
        }
    });
}

/** Turn an invitation down. Quiet: nobody is told, the way a launcher does. */
export async function declineInvite(sessionId: string, userId: string): Promise<void> {
    await prisma.arcadeInvite.updateMany({
        where: { sessionId, userId, declinedAt: null },
        data: { declinedAt: new Date() }
    });
}
