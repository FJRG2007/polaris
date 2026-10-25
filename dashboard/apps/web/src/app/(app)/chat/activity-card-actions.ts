"use server";

/**
 * The card a conversation shows for a game played together, and inviting
 * people to one.
 *
 * Inviting somebody never starts or rings a call. It opens a lobby - the game's
 * own data-only room (`lobby-actions`) - posts its card in the conversation,
 * and offers the invitation in each invitee's toast and bell until it expires
 * or the session ends, the way a game launcher does. Only a game started from a
 * call's Activities button is played in that call, and joining its card goes
 * through the call's own checks, then the game's (`call-activity-actions`).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as card from "@/lib/chat/activity-card";
import { blockedBetween } from "@/lib/blocks";
import { requireChannel, messageable } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { translatorFor } from "@/lib/i18n/translate";
import { MAX_PLAYERS } from "@/lib/chat/call-activity";
import { sessionCan, requireUser } from "@/lib/session";
import * as sessions from "@/lib/chat/activity-sessions";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { createNotification } from "@/lib/notification-service";
import { callActivityGames } from "@/lib/app-extensions/registry";
import { openDirect, listChannels } from "@/lib/chat/chat-service";

/** The most faces a card draws. */
const CARD_FACES = 8;

/** What the card in a conversation shows this reader, or null for a session
 *  that does not exist or one the reader may not see: not in its conversation
 *  and, for a lobby, not invited to it either. */
export async function readActivityCard(sessionId: unknown): Promise<card.ActivityCardView | null> {
    const id = z.string().uuid().safeParse(sessionId);
    if (!id.success) return null;
    const user = await requireUser();
    const session = await sessions.sessionForCard(id.data);
    if (!session) return null;
    const now = Date.now();
    try {
        await requireChannel({ id: user.id }, session.channelId);
    } catch {
        if (session.meetingId !== null || !(await sessions.holdsInvite(session.id, user.id, now)))
            return null;
    }

    const [installed, mayPlay, meeting] = await Promise.all([
        isAppInstalled("arcade"),
        sessionCan(user, "arcade.calls"),
        session.meetingId
            ? prisma.meeting.findUnique({
                  where: { id: session.meetingId },
                  select: { endedAt: true }
              })
            : Promise.resolve({ endedAt: null })
    ]);
    const games = installed ? await callActivityGames(await getUserLocale(user.id)) : [];
    const offered = games.find((game) => game.id === session.game);
    const ended = card.sessionEnded(
        { ...session, callEnded: !meeting || meeting.endedAt !== null },
        now
    );
    // Closed on first sight, so the next reader is not asked to work it out.
    if (ended && !session.endedAt) {
        await prisma.arcadeSession
            .update({ where: { id: session.id }, data: { endedAt: new Date(now) } })
            .catch(() => undefined);
    }

    const playing = ended ? [] : session.players.filter((row) => card.stillPlaying(row, now));
    const shown = playing.slice(0, CARD_FACES).map((row) => row.userId);
    // Once over, everybody who played, for "played by".
    const played = ended ? session.players.slice(0, CARD_FACES).map((row) => row.userId) : [];
    const people = await prisma.user.findMany({
        where: { id: { in: [...new Set([session.startedById, ...shown, ...played])] } },
        select: { id: true, name: true }
    });
    const nameOf = (userId: string) => people.find((person) => person.id === userId)?.name ?? "";
    const inGame = playing.some((row) => row.userId === user.id);

    return {
        sessionId: session.id,
        channelId: session.channelId,
        meetingId: session.meetingId,
        href:
            session.meetingId === null
                ? card.lobbyHref(session.id)
                : card.joinHref(session.channelId, session.id),
        game: session.game,
        gameName: offered?.name ?? "",
        startedBy: { id: session.startedById, name: nameOf(session.startedById) },
        players: shown.map((userId) => ({ id: userId, name: nameOf(userId) })),
        playing: playing.length,
        max: MAX_PLAYERS,
        ended,
        inGame,
        refusal: card.joinRefusal({
            ended,
            installed: Boolean(offered),
            mayPlay,
            playing: playing.length,
            inGame
        }),
        played: played.map((userId) => ({ id: userId, name: nameOf(userId) })),
        durationMs: ended ? card.sessionDuration(session.players, session.endedAt) : null
    };
}

/** Whether the reader may invite people to play, for the Games page to show
 *  its Invite button only to them - and why not, for the rest. */
export async function gameInviteAccess(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: "denied" | "missing" }
> {
    const user = await requireUser();
    if (!(await isAppInstalled("arcade"))) return { ok: false, reason: "missing" };
    if (!(await sessionCan(user, "arcade.calls"))) return { ok: false, reason: "denied" };
    return { ok: true };
}

/** Where the invite dialog can send an invitation: the reader's own
 *  conversations, most recent first. */
export interface InviteTarget {
    readonly id: string;
    readonly name: string;
    readonly kind: "text" | "voice" | "dm" | "group";
}

export async function gameInviteTargets(): Promise<readonly InviteTarget[]> {
    const user = await requireUser();
    if (!(await sessionCan(user, "arcade.calls"))) return [];
    const channels = await listChannels({ id: user.id });
    return channels
        .filter(
            (channel) =>
                !channel.archived &&
                (channel.kind === "text" ||
                    channel.kind === "voice" ||
                    channel.kind === "dm" ||
                    channel.kind === "group")
        )
        .sort((left, right) => (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""))
        .slice(0, 100)
        .map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.kind as InviteTarget["kind"]
        }));
}

/** Why an invitation was not sent, in a word the dialog turns into a sentence. */
export type InviteRefusal =
    "invalid" | "denied" | "missing" | "limited" | "conversation" | "ended" | "failed";

export type InviteAnswer =
    | { readonly ok: true; readonly href: string }
    | { readonly ok: false; readonly reason: InviteRefusal };

/** The most people one invitation notifies. */
const NOTIFY_MAX = 50;

type Inviter = Awaited<ReturnType<typeof requireUser>>;

/** The checks every invitation passes - the app, the permission, the game and
 *  the rate limit, in that order, so a refusal names the first thing wrong. */
async function mayInvite(
    user: Inviter,
    game: string
): Promise<
    | { readonly ok: true; readonly name: string }
    | { readonly ok: false; readonly reason: InviteRefusal }
> {
    if (!(await isAppInstalled("arcade"))) return { ok: false, reason: "missing" };
    if (!(await sessionCan(user, "arcade.calls"))) return { ok: false, reason: "denied" };
    const offered = (await callActivityGames(await getUserLocale(user.id))).find(
        (entry) => entry.id === game
    );
    if (!offered) return { ok: false, reason: "missing" };
    const limit = await rateLimit(
        `arcade-invite:${user.id}`,
        card.INVITE_LIMIT,
        card.INVITE_WINDOW_MS
    );
    if (!limit.ok) return { ok: false, reason: "limited" };
    return { ok: true, name: offered.name };
}

/** Of these people, the ones an invitation may reach: an account that exists,
 *  has the chat, and has no block with the inviter either way. */
async function reachableBy(inviterId: string, userIds: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(userIds)].filter((id) => id !== inviterId).slice(0, NOTIFY_MAX);
    if (wanted.length === 0) return [];
    const [present, chatting, blocked] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true } }),
        messageable(wanted),
        blockedBetween(inviterId, wanted)
    ]);
    const exists = new Set(present.map((row) => row.id));
    return wanted.filter((id) => exists.has(id) && chatting.has(id) && !blocked.has(id));
}

/** Offer the invitation in each invitee's toast and bell, and answer how many
 *  it reached. */
async function tell(
    session: { readonly id: string; readonly channelId: string },
    user: Inviter,
    gameName: string,
    userIds: readonly string[],
    href: string
): Promise<number> {
    const audience = await reachableBy(user.id, userIds);
    if (audience.length === 0) return 0;
    await sessions.inviteTo(session, user.id, audience);
    for (const userId of audience) {
        const t = translatorFor(await getUserLocale(userId), "chat");
        await createNotification({
            userId,
            type: "arcade.invite",
            title: t("activityCard.invited", { name: user.name, game: gameName }),
            href
        });
    }
    return audience.length;
}

/**
 * Invite people to play: open a lobby for the game, post its card in the
 * conversation and offer the invitation to whoever was invited. No call starts
 * and nothing rings. Answers where the inviter goes to play - the lobby.
 */
export async function inviteToGame(input: unknown): Promise<InviteAnswer> {
    const parsed = card.inviteInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const user = await requireUser();
    const allowed = await mayInvite(user, parsed.data.game);
    if (!allowed.ok) return allowed;

    const actor = { id: user.id };
    let channelId: string;
    try {
        if ("channelId" in parsed.data) {
            await requireChannel(actor, parsed.data.channelId);
            channelId = parsed.data.channelId;
        } else {
            channelId = await openDirect(actor, parsed.data.userIds);
        }
    } catch {
        return { ok: false, reason: "conversation" };
    }

    let session: sessions.SessionRow;
    try {
        session = await sessions.openLobby(channelId, parsed.data.game, user.id);
    } catch {
        return { ok: false, reason: "failed" };
    }
    const href = card.lobbyHref(session.id);
    // The people picked, or everybody in a direct message or group. A channel
    // in a server is told by its card alone - a toast for every member of a
    // server is not an invitation.
    const audience =
        "userIds" in parsed.data ? parsed.data.userIds : await directAudience(channelId);
    await tell(session, user, allowed.name, audience, href);
    return { ok: true, href };
}

export type SessionInviteAnswer =
    | { readonly ok: true; readonly invited: number; readonly skipped: number }
    | { readonly ok: false; readonly reason: InviteRefusal };

/**
 * Invite more people to a session the reader is playing, from its lobby or
 * from the game panel in a call. A lobby takes anybody invited. A call's game
 * is joined through the call, so only people in the call's conversation can
 * take it up; the rest are skipped and the answer counts them.
 */
export async function inviteToSession(input: unknown): Promise<SessionInviteAnswer> {
    const parsed = card.sessionInviteSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const user = await requireUser();
    const session = await sessions.sessionForCard(parsed.data.sessionId);
    const now = Date.now();
    if (
        !session ||
        session.endedAt ||
        !session.players.some((row) => row.userId === user.id && card.stillPlaying(row, now))
    )
        return { ok: false, reason: "ended" };
    const allowed = await mayInvite(user, session.game);
    if (!allowed.ok) return allowed;

    const wanted = [...new Set(parsed.data.userIds)].filter((id) => id !== user.id);
    let reachable = wanted;
    if (session.meetingId !== null) {
        const members = await prisma.chatChannelMember.findMany({
            where: { channelId: session.channelId, userId: { in: wanted } },
            select: { userId: true }
        });
        const inIt = new Set(members.map((row) => row.userId));
        reachable = wanted.filter((id) => inIt.has(id));
    }
    const href =
        session.meetingId === null
            ? card.lobbyHref(session.id)
            : card.joinHref(session.channelId, session.id);
    const invited = await tell(session, user, allowed.name, reachable, href);
    return { ok: true, invited, skipped: wanted.length - invited };
}

/** The session a call is playing, for its game panel's Invite button: the
 *  open one of this game in this meeting, or null. */
export async function callSessionId(meetingId: unknown, game: unknown): Promise<string | null> {
    const id = z.string().uuid().safeParse(meetingId);
    const wanted = z.string().max(48).safeParse(game);
    if (!id.success || !wanted.success) return null;
    const user = await requireUser();
    const found = await prisma.arcadeSession.findFirst({
        where: {
            meetingId: id.data,
            game: wanted.data,
            endedAt: null,
            players: { some: { userId: user.id, leftAt: null } }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true }
    });
    return found?.id ?? null;
}

/** An invitation as the toast draws it. */
export interface PendingInvite {
    readonly sessionId: string;
    readonly game: string;
    readonly gameName: string;
    readonly from: { readonly id: string; readonly name: string };
    readonly href: string;
    readonly inCall: boolean;
    readonly expiresAt: string;
}

/** The invitations still offered to the reader: not declined, not expired, the
 *  session still running and the reader not already in it. */
export async function pendingGameInvites(): Promise<readonly PendingInvite[]> {
    const user = await requireUser();
    if (!(await isAppInstalled("arcade"))) return [];
    const now = Date.now();
    const rows = await sessions.openInvites(user.id, now);
    if (rows.length === 0) return [];
    const meetingIds = rows.flatMap((row) =>
        row.session.meetingId ? [row.session.meetingId] : []
    );
    const [meetings, people, games] = await Promise.all([
        meetingIds.length > 0
            ? prisma.meeting.findMany({
                  where: { id: { in: meetingIds } },
                  select: { id: true, endedAt: true }
              })
            : Promise.resolve([] as { id: string; endedAt: Date | null }[]),
        prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.invitedById))] } },
            select: { id: true, name: true }
        }),
        callActivityGames(await getUserLocale(user.id))
    ]);
    return rows
        .filter((row) => {
            const meeting = meetings.find((one) => one.id === row.session.meetingId);
            const callEnded =
                row.session.meetingId !== null && (!meeting || meeting.endedAt !== null);
            const over = card.sessionEnded({ ...row.session, callEnded }, now);
            const inGame = row.session.players.some(
                (player) => player.userId === user.id && card.stillPlaying(player, now)
            );
            return card.inviteOpen(row, over, now) && !inGame;
        })
        .map((row) => ({
            sessionId: row.session.id,
            game: row.session.game,
            gameName: games.find((game) => game.id === row.session.game)?.name ?? "",
            from: {
                id: row.invitedById,
                name: people.find((person) => person.id === row.invitedById)?.name ?? ""
            },
            href:
                row.session.meetingId === null
                    ? card.lobbyHref(row.session.id)
                    : card.joinHref(row.session.channelId, row.session.id),
            inCall: row.session.meetingId !== null,
            expiresAt: row.expiresAt.toISOString()
        }));
}

/** Turn an invitation down. */
export async function declineGameInvite(sessionId: unknown): Promise<void> {
    const id = z.string().uuid().safeParse(sessionId);
    if (!id.success) return;
    const user = await requireUser();
    await sessions.declineInvite(id.data, user.id);
}

/** Everybody in a direct message or a group, or nobody for a channel. */
async function directAudience(channelId: string): Promise<string[]> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true, members: { select: { userId: true }, take: NOTIFY_MAX + 1 } }
    });
    if (!channel || (channel.kind !== "dm" && channel.kind !== "group")) return [];
    return channel.members.map((row) => row.userId);
}
