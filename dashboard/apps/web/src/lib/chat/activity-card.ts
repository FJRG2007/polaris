/**
 * The card a conversation shows for a game played in its call - like a
 * "started an activity" line in other messengers: the game, who is playing,
 * and a way in that says why when there is none.
 *
 * The card is a `system` message whose body is nothing but the session's mark,
 * so the reader finds it without asking the server, and an old screen that does
 * not know the mark shows it as a quiet line rather than breaking. What the card
 * says is read again every time from the session, never stored on the message.
 *
 * Pure, so every state can be checked without a database.
 */

import { z } from "zod";
import { MAX_PLAYERS, PASS_TTL_MS } from "./call-activity";

const MARK_PREFIX = "polaris-activity:";

const sessionIdSchema = z.string().uuid();

/** The body of the card's message. */
export function activityMark(sessionId: string): string {
    return `${MARK_PREFIX}${sessionId}`;
}

/** The session a message body is the card of, or null for any other body. */
export function activityIdIn(body: string): string | null {
    if (!body.startsWith(MARK_PREFIX)) return null;
    const id = sessionIdSchema.safeParse(body.slice(MARK_PREFIX.length));
    return id.success ? id.data : null;
}

/** How long a session somebody was invited to waits for its first player
 *  before the card calls it over. */
export const INVITE_WAIT_MS = 3 * 60 * 1000;

/** One player row as stored. */
export interface PlayerRow {
    readonly userId: string;
    readonly seenAt: Date;
    readonly leftAt: Date | null;
}

/** Whether a player still counts: renewed within a pass's life, and not gone. */
export function stillPlaying(row: PlayerRow, now: number): boolean {
    return row.leftAt === null && now - row.seenAt.getTime() <= PASS_TTL_MS;
}

/** The facts the card is drawn from. */
export interface SessionFacts {
    readonly createdAt: Date;
    readonly endedAt: Date | null;
    /** Whether the call hosting it has ended. */
    readonly callEnded: boolean;
    readonly players: readonly PlayerRow[];
}

/** Whether a session is over: closed, its call closed, or nobody left in it -
 *  except for the few minutes an invited session waits for its first player. */
export function sessionEnded(facts: SessionFacts, now: number): boolean {
    if (facts.endedAt || facts.callEnded) return true;
    if (facts.players.some((row) => stillPlaying(row, now))) return false;
    const everPlayed = facts.players.length > 0;
    return everPlayed || now - facts.createdAt.getTime() > INVITE_WAIT_MS;
}

/** Why the reader cannot join from the card, or null when they can. */
export type JoinRefusal = "denied" | "missing" | "full" | "ended";

export interface JoinFacts {
    readonly ended: boolean;
    readonly installed: boolean;
    readonly mayPlay: boolean;
    readonly playing: number;
    /** Whether the reader is already one of the players. */
    readonly inGame: boolean;
}

/** The first reason the reader cannot join, in the order that helps them most:
 *  a game that is over says so before anything about the reader. */
export function joinRefusal(facts: JoinFacts): JoinRefusal | null {
    if (facts.ended) return "ended";
    if (!facts.installed) return "missing";
    if (!facts.mayPlay) return "denied";
    if (!facts.inGame && facts.playing >= MAX_PLAYERS) return "full";
    return null;
}

/** What the card shows a reader. */
export interface ActivityCardView {
    readonly sessionId: string;
    readonly channelId: string;
    readonly meetingId: string;
    readonly game: string;
    readonly gameName: string;
    readonly startedBy: { readonly id: string; readonly name: string };
    /** Earliest first, at most what the card draws. */
    readonly players: readonly { readonly id: string; readonly name: string }[];
    readonly playing: number;
    readonly max: number;
    readonly ended: boolean;
    readonly inGame: boolean;
    readonly refusal: JoinRefusal | null;
}

/** The input the invite action takes. One destination: a conversation the
 *  reader is in, or people to play with (a direct message for one, a group for
 *  several). */
export const inviteInputSchema = z.union([
    z
        .object({
            game: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
            channelId: z.string().uuid()
        })
        .strict(),
    z
        .object({
            game: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
            userIds: z.array(z.string().uuid()).min(1).max(9)
        })
        .strict()
]);

export type InviteInput = z.infer<typeof inviteInputSchema>;

/** How many invitations one person may send, and in what window. */
export const INVITE_LIMIT = 10;
export const INVITE_WINDOW_MS = 10 * 60 * 1000;

/** Where joining from a card or a notification takes the reader. */
export function joinHref(channelId: string, sessionId: string): string {
    return `/chat/c/${channelId}?activity=${sessionId}`;
}
