"use server";

/**
 * Games in a call, as the server decides them.
 *
 * The call's media server carries the claims and the positions between
 * browsers, and believes whatever a browser writes about itself - so the
 * decision is made here instead: a seat may start or join a game only with a
 * pass this file mints, after checking the account holds `arcade.calls`, the
 * Games app is installed and offers that game, and the seat is the reader's own
 * admitted seat in that call. Every other browser asks this file whether a
 * claim's pass is real before it counts the player - see `lib/chat/call-activity`.
 */

import { z } from "zod";
import { seatForUser } from "@/lib/chat/meetings";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { sessionCan, requireUser } from "@/lib/session";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import type { AppSlot } from "@/lib/app-extensions/types";
import { callActivityGames } from "@/lib/app-extensions/registry";
import { activityPass, readActivityPass } from "@/lib/chat/activity-pass";
import { leavePlay, recordPlay, touchPlay } from "@/lib/chat/activity-sessions";
import { activityClaimSchema, MAX_PLAYERS, type ActivityClaim } from "@/lib/chat/call-activity";

/** Why the games button cannot be used, in a word the screen turns into a sentence. */
export type CallGamesRefusal = "missing" | "denied" | "seat";

export interface CallGame {
    readonly id: string;
    readonly name: string;
    readonly src: string;
    /** What draws it inside the call. */
    readonly slot: AppSlot;
}

export type CallGamesAnswer =
    | { readonly ok: true; readonly seat: string; readonly games: readonly CallGame[] }
    | { readonly ok: false; readonly reason: CallGamesRefusal };

const meetingIdSchema = z.string().uuid();
const gameIdSchema = activityClaimSchema.shape.game;

/** What the reader may do with games in this call, and which games there are. */
async function access(meetingId: string): Promise<CallGamesAnswer> {
    return (await accessOf(meetingId)).answer;
}

/** The same, with whose answer it is - for the record the conversation's card
 *  is read from. */
async function accessOf(
    meetingId: string
): Promise<{ readonly answer: CallGamesAnswer; readonly userId: string }> {
    const user = await requireUser();
    return { answer: await decide(user, meetingId), userId: user.id };
}

async function decide(
    user: Awaited<ReturnType<typeof requireUser>>,
    meetingId: string
): Promise<CallGamesAnswer> {
    if (!(await isAppInstalled("arcade"))) return { ok: false, reason: "missing" };
    if (!(await sessionCan(user, "arcade.calls"))) return { ok: false, reason: "denied" };
    const seat = await seatForUser(user.id, meetingId);
    if (!seat || seat.admission !== "admitted") return { ok: false, reason: "seat" };
    const games = await callActivityGames(await getUserLocale(user.id));
    if (games.length === 0) return { ok: false, reason: "missing" };
    return { ok: true, seat: seat.participantId, games };
}

/** The games the reader may start or join in this call, or why none. */
export async function callGames(meetingId: unknown): Promise<CallGamesAnswer> {
    const id = meetingIdSchema.safeParse(meetingId);
    if (!id.success) return { ok: false, reason: "seat" };
    return access(id.data);
}

/**
 * Start a game in this call, or join the one it is playing: the claim the
 * reader's browser writes into its attribute, with the pass that makes the
 * others believe it.
 */
export async function claimCallGame(
    meetingId: unknown,
    game: unknown
): Promise<{ readonly claim: ActivityClaim } | { readonly reason: CallGamesRefusal }> {
    const id = meetingIdSchema.safeParse(meetingId);
    const wanted = gameIdSchema.safeParse(game);
    if (!id.success || !wanted.success) return { reason: "missing" };
    const { answer, userId } = await accessOf(id.data);
    if (!answer.ok) return { reason: answer.reason };
    if (!answer.games.some((offered) => offered.id === wanted.data)) return { reason: "missing" };
    const at = Date.now();
    const facts = { meetingId: id.data, seat: answer.seat, game: wanted.data, at };
    const pass = activityPass(facts);
    // The card in the call's conversation follows who plays.
    await recordPlay(id.data, userId, wanted.data);
    return { claim: { game: wanted.data, at, pass } };
}

/** How long after a pass ran out it may still be renewed: a laptop that slept
 *  through the renewal is not thrown out of the game for it. */
const RENEW_GRACE_MS = 60 * 1000;

/**
 * Renew the reader's pass while they play, asking every question again: still
 * `arcade.calls`, still installed, still their admitted seat, still a game
 * the app offers. A refusal is how a revoked player leaves the game - their
 * browser takes its claim back, and everybody else's stops counting it once
 * the old pass runs out. Keeps the moment they joined, so the order of
 * players does not change; only a pass this server minted for this seat can
 * be renewed.
 */
export async function renewCallGame(
    meetingId: unknown,
    claim: unknown
): Promise<{ readonly claim: ActivityClaim } | { readonly reason: CallGamesRefusal }> {
    const id = meetingIdSchema.safeParse(meetingId);
    const held = activityClaimSchema.safeParse(claim);
    if (!id.success || !held.success) return { reason: "missing" };
    const { answer, userId } = await accessOf(id.data);
    if (!answer.ok) return { reason: answer.reason };
    const { game, at, pass } = held.data;
    if (!answer.games.some((offered) => offered.id === game)) return { reason: "missing" };
    const facts = { meetingId: id.data, seat: answer.seat, game, at };
    if (!readActivityPass(pass, facts, Date.now() - RENEW_GRACE_MS)) return { reason: "seat" };
    await touchPlay(id.data, userId, game);
    return { claim: { game, at, pass: activityPass(facts) } };
}

/**
 * The reader stopped playing this call's game, so the card stops counting
 * them - and says the game is over once nobody is left. Their claim is taken
 * back by their own browser; this is only the record. Needs no permission:
 * anybody may stop playing.
 */
export async function leaveCallGame(meetingId: unknown): Promise<void> {
    const id = meetingIdSchema.safeParse(meetingId);
    if (!id.success) return;
    const user = await requireUser();
    await leavePlay(id.data, user.id);
}

const vouchSchema = z
    .array(z.object({ seat: z.string().min(1).max(128), claim: activityClaimSchema }).strict())
    .max(MAX_PLAYERS * 2);

export interface CallGamesVouch {
    readonly seats: string[];
    /** The server's clock, so a browser whose own runs early or late judges
     *  when a pass runs out by this one instead. */
    readonly now: number;
}

/**
 * Which of these claims the server minted: the seats whose pass is real for
 * this call, this seat, this game and this moment. Asked by anybody holding a
 * seat in the call - a guest included, who sees who is playing without being
 * able to join.
 */
export async function vouchCallGames(meetingId: unknown, claims: unknown): Promise<CallGamesVouch> {
    const now = Date.now();
    const id = meetingIdSchema.safeParse(meetingId);
    const parsed = vouchSchema.safeParse(claims);
    if (!id.success || !parsed.success) return { seats: [], now };
    const seat = await resolveSeat(id.data);
    if (!seat || seat.admission !== "admitted") return { seats: [], now };
    const seats = parsed.data
        .filter(({ seat: claimant, claim }) =>
            readActivityPass(
                claim.pass,
                {
                    meetingId: id.data,
                    seat: claimant,
                    game: claim.game,
                    at: claim.at
                },
                now
            )
        )
        .map(({ seat: claimant }) => claimant);
    return { seats, now };
}
