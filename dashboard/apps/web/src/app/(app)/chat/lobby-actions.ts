"use server";

/**
 * Game lobbies, as the server decides them: a game somebody was invited to,
 * played with no call around it (see `lib/chat/activity-sessions`).
 *
 * The same claims and passes as a game in a call (`call-activity-actions`),
 * with two differences. The room is the lobby's own data-only room, and the
 * seat is the account - one per account, as in a game launcher. Passes are
 * signed for the lobby rather than for a meeting, so one is worth nothing in
 * the other.
 *
 * Who may be in a lobby: an account holding `arcade.calls`, with the Games app
 * installed, who is in the conversation its card was posted in or holds an
 * invitation to it that is still offered - while it runs and has room.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as card from "@/lib/chat/activity-card";
import { requireChannel } from "@/lib/chat/access";
import { sessionCan, requireUser } from "@/lib/session";
import * as sessions from "@/lib/chat/activity-sessions";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { callServer, lobbyToken } from "@/lib/chat/call-server";
import { callActivityGames } from "@/lib/app-extensions/registry";
import { activityPass, readActivityPass } from "@/lib/chat/activity-pass";
import { activityClaimSchema, MAX_PLAYERS, type ActivityClaim } from "@/lib/chat/call-activity";
import type { CallGamesAnswer, CallGamesRefusal, CallGamesVouch } from "./call-activity-actions";

const sessionIdSchema = z.string().uuid();

/** Why somebody cannot be in a lobby, in a word the page turns into a sentence. */
export type LobbyRefusal = "missing" | "denied" | "ended" | "full" | "access" | "server";

type User = Awaited<ReturnType<typeof requireUser>>;

interface Admitted {
    readonly ok: true;
    readonly session: NonNullable<Awaited<ReturnType<typeof sessions.sessionForCard>>>;
    readonly games: Awaited<ReturnType<typeof callActivityGames>>;
}

/** Every question, asked again on every call. */
async function admit(
    user: User,
    sessionId: string,
    now = Date.now()
): Promise<Admitted | { readonly ok: false; readonly reason: LobbyRefusal }> {
    if (!(await isAppInstalled("arcade"))) return { ok: false, reason: "missing" };
    if (!(await sessionCan(user, "arcade.calls"))) return { ok: false, reason: "denied" };
    const session = await sessions.sessionForCard(sessionId);
    if (!session || session.meetingId !== null) return { ok: false, reason: "access" };
    if (card.sessionEnded({ ...session, callEnded: false }, now))
        return { ok: false, reason: "ended" };
    const playing = session.players.filter((row) => card.stillPlaying(row, now));
    const inGame = playing.some((row) => row.userId === user.id);
    if (!inGame && !(await mayReach(user.id, session.channelId, session.id, now)))
        return { ok: false, reason: "access" };
    if (!inGame && playing.length >= MAX_PLAYERS) return { ok: false, reason: "full" };
    const games = (await callActivityGames(await getUserLocale(user.id))).filter(
        (game) => game.id === session.game
    );
    if (games.length === 0) return { ok: false, reason: "missing" };
    return { ok: true, session, games };
}

/** In the card's conversation, or invited. */
async function mayReach(
    userId: string,
    channelId: string,
    sessionId: string,
    now: number
): Promise<boolean> {
    try {
        await requireChannel({ id: userId }, channelId);
        return true;
    } catch {
        return sessions.holdsInvite(sessionId, userId, now);
    }
}

function refusalFor(reason: LobbyRefusal): CallGamesRefusal {
    return reason === "missing" || reason === "denied" ? reason : "seat";
}

export type LobbyEntry =
    | {
          readonly ok: true;
          readonly url: string;
          readonly token: string;
          readonly seat: string;
          readonly game: string;
          readonly channelId: string;
          readonly member: boolean;
      }
    | { readonly ok: false; readonly reason: LobbyRefusal };

/** A ticket into the lobby's room, or why not. */
export async function enterLobby(sessionId: unknown): Promise<LobbyEntry> {
    const id = sessionIdSchema.safeParse(sessionId);
    if (!id.success) return { ok: false, reason: "access" };
    const user = await requireUser();
    const admitted = await admit(user, id.data);
    if (!admitted.ok) return admitted;
    const endpoint = await callServer();
    if (!endpoint) return { ok: false, reason: "server" };
    const [token, member] = await Promise.all([
        lobbyToken(endpoint, card.lobbyRoom(id.data), user.id, user.name),
        requireChannel({ id: user.id }, admitted.session.channelId).then(
            () => true,
            () => false
        )
    ]);
    return {
        ok: true,
        url: endpoint.url,
        token,
        seat: user.id,
        game: admitted.session.game,
        channelId: admitted.session.channelId,
        member
    };
}

/** The lobby's game, for the activity hook, or why the reader cannot play it. */
export async function lobbyGames(sessionId: unknown): Promise<CallGamesAnswer> {
    const id = sessionIdSchema.safeParse(sessionId);
    if (!id.success) return { ok: false, reason: "seat" };
    const user = await requireUser();
    const admitted = await admit(user, id.data);
    if (!admitted.ok) return { ok: false, reason: refusalFor(admitted.reason) };
    return { ok: true, seat: user.id, games: admitted.games };
}

/** Join the lobby's game: the claim this browser writes, with its pass. */
export async function claimLobbyGame(
    sessionId: unknown,
    game: unknown
): Promise<{ readonly claim: ActivityClaim } | { readonly reason: CallGamesRefusal }> {
    const id = sessionIdSchema.safeParse(sessionId);
    const wanted = activityClaimSchema.shape.game.safeParse(game);
    if (!id.success || !wanted.success) return { reason: "missing" };
    const user = await requireUser();
    const admitted = await admit(user, id.data);
    if (!admitted.ok) return { reason: refusalFor(admitted.reason) };
    if (wanted.data !== admitted.session.game) return { reason: "missing" };
    const at = Date.now();
    const facts = { meetingId: card.lobbyPassScope(id.data), seat: user.id, game: wanted.data, at };
    await sessions.recordLobbyPlay(id.data, user.id);
    return { claim: { game: wanted.data, at, pass: activityPass(facts) } };
}

/** How long after a pass ran out it may still be renewed. */
const RENEW_GRACE_MS = 60 * 1000;

/** Renew the pass while playing, asking everything again. */
export async function renewLobbyGame(
    sessionId: unknown,
    claim: unknown
): Promise<{ readonly claim: ActivityClaim } | { readonly reason: CallGamesRefusal }> {
    const id = sessionIdSchema.safeParse(sessionId);
    const held = activityClaimSchema.safeParse(claim);
    if (!id.success || !held.success) return { reason: "missing" };
    const user = await requireUser();
    const admitted = await admit(user, id.data);
    if (!admitted.ok) return { reason: refusalFor(admitted.reason) };
    const { game, at, pass } = held.data;
    if (game !== admitted.session.game) return { reason: "missing" };
    const facts = { meetingId: card.lobbyPassScope(id.data), seat: user.id, game, at };
    if (!readActivityPass(pass, facts, Date.now() - RENEW_GRACE_MS)) return { reason: "seat" };
    await sessions.touchLobbyPlay(id.data, user.id);
    return { claim: { game, at, pass: activityPass(facts) } };
}

/** The reader left the lobby. Anybody may; the last one out ends it. */
export async function leaveLobbyGame(sessionId: unknown): Promise<void> {
    const id = sessionIdSchema.safeParse(sessionId);
    if (!id.success) return;
    const user = await requireUser();
    await sessions.leaveLobbyPlay(id.data, user.id);
}

const vouchSchema = z
    .array(z.object({ seat: z.string().min(1).max(128), claim: activityClaimSchema }).strict())
    .max(MAX_PLAYERS * 2);

/** Which of these claims the server minted for this lobby. Asked only by
 *  somebody who may be in it. */
export async function vouchLobbyGames(
    sessionId: unknown,
    claims: unknown
): Promise<CallGamesVouch> {
    const now = Date.now();
    const id = sessionIdSchema.safeParse(sessionId);
    const parsed = vouchSchema.safeParse(claims);
    if (!id.success || !parsed.success) return { seats: [], now };
    const user = await requireUser();
    const session = await prisma.arcadeSession.findFirst({
        where: { id: id.data, meetingId: null },
        select: { channelId: true, players: { where: { userId: user.id }, select: { userId: true } } }
    });
    if (!session) return { seats: [], now };
    if (
        session.players.length === 0 &&
        !(await mayReach(user.id, session.channelId, id.data, now))
    )
        return { seats: [], now };
    const scope = card.lobbyPassScope(id.data);
    const seats = parsed.data
        .filter(({ seat, claim }) =>
            readActivityPass(
                claim.pass,
                { meetingId: scope, seat, game: claim.game, at: claim.at },
                now
            )
        )
        .map(({ seat }) => seat);
    return { seats, now };
}
