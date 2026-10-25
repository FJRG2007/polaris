"use server";

/**
 * The card a conversation shows for a game played in its call, and inviting
 * people to one from the Games app.
 *
 * A game is always played inside a call - that call's media server is what
 * carries the players between browsers - so inviting somebody to play starts
 * (or joins) a call in the conversation they are invited to, the way a game
 * started in a direct message is in other messengers. Joining from the card
 * goes through the call's own checks, then the game's (`call-activity-actions`).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as card from "@/lib/chat/activity-card";
import { startOrJoin } from "@/lib/chat/meetings";
import { requireChannel } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { translatorFor } from "@/lib/i18n/translate";
import { MAX_PLAYERS } from "@/lib/chat/call-activity";
import { sessionCan, requireUser } from "@/lib/session";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { createNotification } from "@/lib/notification-service";
import { callActivityGames } from "@/lib/app-extensions/registry";
import { openDirect, listChannels } from "@/lib/chat/chat-service";
import { openSession, sessionForCard } from "@/lib/chat/activity-sessions";

/** The most faces a card draws. */
const CARD_FACES = 8;

/** What the card in a conversation shows this reader, or null for a session
 *  that does not exist or a conversation the reader is not in. */
export async function readActivityCard(sessionId: unknown): Promise<card.ActivityCardView | null> {
    const id = z.string().uuid().safeParse(sessionId);
    if (!id.success) return null;
    const user = await requireUser();
    const session = await sessionForCard(id.data);
    if (!session) return null;
    try {
        await requireChannel({ id: user.id }, session.channelId);
    } catch {
        return null;
    }

    const now = Date.now();
    const [installed, mayPlay, meeting] = await Promise.all([
        isAppInstalled("arcade"),
        sessionCan(user, "arcade.calls"),
        prisma.meeting.findUnique({ where: { id: session.meetingId }, select: { endedAt: true } })
    ]);
    const games = installed ? await callActivityGames(await getUserLocale(user.id)) : [];
    const offered = games.find((game) => game.id === session.game);
    const ended = card.sessionEnded({ ...session, callEnded: !meeting || meeting.endedAt !== null }, now);
    // Closed on first sight, so the next reader is not asked to work it out.
    if (ended && !session.endedAt) {
        await prisma.arcadeSession
            .update({ where: { id: session.id }, data: { endedAt: new Date(now) } })
            .catch(() => undefined);
    }

    const playing = ended ? [] : session.players.filter((row) => card.stillPlaying(row, now));
    const shown = playing.slice(0, CARD_FACES).map((row) => row.userId);
    const people = await prisma.user.findMany({
        where: { id: { in: [...new Set([session.startedById, ...shown])] } },
        select: { id: true, name: true }
    });
    const nameOf = (userId: string) => people.find((person) => person.id === userId)?.name ?? "";
    const inGame = playing.some((row) => row.userId === user.id);

    return {
        sessionId: session.id,
        channelId: session.channelId,
        meetingId: session.meetingId,
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
        })
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
export type InviteRefusal = "invalid" | "denied" | "missing" | "limited" | "conversation" | "call";

export type InviteAnswer =
    | { readonly ok: true; readonly href: string }
    | { readonly ok: false; readonly reason: InviteRefusal };

/** The most people one invitation notifies. */
const NOTIFY_MAX = 50;

/**
 * Invite people to play: start or join the call in the conversation, open the
 * game's session there with its card, and tell whoever was invited. Answers
 * where the inviter goes to play - the call, with the game starting.
 */
export async function inviteToGame(input: unknown): Promise<InviteAnswer> {
    const parsed = card.inviteInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const user = await requireUser();
    if (!(await isAppInstalled("arcade"))) return { ok: false, reason: "missing" };
    if (!(await sessionCan(user, "arcade.calls"))) return { ok: false, reason: "denied" };
    const locale = await getUserLocale(user.id);
    const offered = (await callActivityGames(locale)).find((game) => game.id === parsed.data.game);
    if (!offered) return { ok: false, reason: "missing" };
    const limit = await rateLimit(
        `arcade-invite:${user.id}`,
        card.INVITE_LIMIT,
        card.INVITE_WINDOW_MS
    );
    if (!limit.ok) return { ok: false, reason: "limited" };

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

    let meetingId: string;
    try {
        meetingId = (await startOrJoin({ id: user.id, name: user.name }, channelId)).meetingId;
    } catch {
        return { ok: false, reason: "call" };
    }
    const session = await openSession(meetingId, offered.id, user.id);
    if (!session) return { ok: false, reason: "call" };
    const href = card.joinHref(channelId, session.id);

    // Told in their bell as well as in the conversation: the people picked, or
    // everybody in a direct message or group. A channel in a server is told by
    // its card alone - a bell for every member of a server is not an invitation.
    const audience =
        "userIds" in parsed.data
            ? parsed.data.userIds
            : await directAudience(channelId);
    for (const userId of audience.filter((id) => id !== user.id).slice(0, NOTIFY_MAX)) {
        const t = translatorFor(await getUserLocale(userId), "chat");
        await createNotification({
            userId,
            type: "arcade.invite",
            title: t("activityCard.invited", { name: user.name, game: offered.name }),
            href
        });
    }
    return { ok: true, href };
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
