"use server";

/**
 * Game rooms, as the server decides them: a lobby opened from the Games
 * library, with no conversation and no card around it. Played exactly like a
 * lobby - same page, same data-only room, same passes (`lobby-actions`) - and
 * reached three ways: by its short code, by an invitation from somebody in it
 * (`inviteToSession`), or, for a public room, from the list.
 *
 * Every action asks the same things first: the Games app is installed and the
 * reader may open it and play with others (`arcade.open`, `arcade.calls`).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomInt } from "node:crypto";
import * as codes from "@/lib/arcade/room-code";
import * as card from "@/lib/chat/activity-card";
import { rateLimit } from "@/lib/rate-limit-service";
import { MAX_PLAYERS } from "@/lib/chat/call-activity";
import { sessionCan, requireUser } from "@/lib/session";
import * as sessions from "@/lib/chat/activity-sessions";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { callActivityGames } from "@/lib/app-extensions/registry";

/** Why a room action was refused, in a word the screen turns into a sentence. */
export type RoomRefusal =
    "invalid" | "denied" | "missing" | "limited" | "unknown" | "full" | "failed";

type User = Awaited<ReturnType<typeof requireUser>>;

const createSchema = z
    .object({ game: z.string().trim().min(1).max(48), isPublic: z.boolean() })
    .strict();
const joinSchema = z.object({ code: codes.roomCodeSchema }).strict();

/** The app, then the permissions, so a refusal names the first thing wrong. */
async function mayPlayTogether(user: User): Promise<RoomRefusal | null> {
    if (!(await isAppInstalled("arcade"))) return "missing";
    if (!(await sessionCan(user, "arcade.open"))) return "denied";
    if (!(await sessionCan(user, "arcade.calls"))) return "denied";
    return null;
}

/** A fresh code, drawn from a cryptographic source. */
function drawCode(): string {
    let code = "";
    for (let index = 0; index < codes.ROOM_CODE_LENGTH; index += 1)
        code += codes.ROOM_CODE_ALPHABET[randomInt(codes.ROOM_CODE_ALPHABET.length)];
    return code;
}

export type RoomAnswer =
    | { readonly ok: true; readonly href: string }
    | { readonly ok: false; readonly reason: RoomRefusal };

/** Open a room for a game and answer where its opener goes to play. */
export async function createGameRoom(input: unknown): Promise<RoomAnswer> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const user = await requireUser();
    const refused = await mayPlayTogether(user);
    if (refused) return { ok: false, reason: refused };
    const offered = (await callActivityGames(await getUserLocale(user.id))).some(
        (game) => game.id === parsed.data.game
    );
    if (!offered) return { ok: false, reason: "missing" };
    const limit = await rateLimit(
        `arcade-room-open:${user.id}`,
        codes.ROOM_CREATE_LIMIT,
        codes.ROOM_CREATE_WINDOW_MS
    );
    if (!limit.ok) return { ok: false, reason: "limited" };
    try {
        const room = await sessions.openRoom(
            parsed.data.game,
            user.id,
            parsed.data.isPublic,
            drawCode
        );
        return { ok: true, href: card.lobbyHref(room.id) };
    } catch (caught) {
        console.error("[arcade] could not open a room", caught);
        return { ok: false, reason: "failed" };
    }
}

/**
 * Join a room by its code. Every attempt counts against the reader's limit,
 * a right one as much as a wrong one, so codes cannot be walked. A code that
 * names no running room says so, the same for one that never existed and one
 * whose room is over.
 */
export async function joinGameRoom(input: unknown): Promise<RoomAnswer> {
    const parsed = joinSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const user = await requireUser();
    const refused = await mayPlayTogether(user);
    if (refused) return { ok: false, reason: refused };
    const limit = await rateLimit(
        `arcade-room-code:${user.id}`,
        codes.ROOM_JOIN_LIMIT,
        codes.ROOM_JOIN_WINDOW_MS
    );
    if (!limit.ok) return { ok: false, reason: "limited" };
    const found = await sessions.roomByCode(parsed.data.code);
    if (!found) return { ok: false, reason: "unknown" };
    const session = await sessions.sessionForCard(found.id);
    const now = Date.now();
    if (!session || card.sessionEnded({ ...session, callEnded: false }, now))
        return { ok: false, reason: "unknown" };
    const playing = session.players.filter((row) => card.stillPlaying(row, now));
    const inGame = playing.some((row) => row.userId === user.id);
    if (!inGame && playing.length >= MAX_PLAYERS) return { ok: false, reason: "full" };
    await sessions.grantRoom(found.id, user.id, now);
    return { ok: true, href: card.lobbyHref(found.id) };
}

/** A public room as the list draws it. */
export interface PublicRoom {
    readonly id: string;
    readonly game: string;
    readonly gameName: string;
    readonly host: { readonly id: string; readonly name: string };
    readonly players: number;
    readonly max: number;
    readonly href: string;
}

export type PublicRoomsAnswer =
    | { readonly ok: true; readonly rooms: readonly PublicRoom[] }
    | { readonly ok: false; readonly reason: RoomRefusal };

/** The public rooms the reader could join now: running, of a game they can
 *  play, with a seat left. Answers why not for somebody who cannot play. */
export async function publicGameRooms(): Promise<PublicRoomsAnswer> {
    const user = await requireUser();
    const refused = await mayPlayTogether(user);
    if (refused) return { ok: false, reason: refused };
    const now = Date.now();
    const [rows, games] = await Promise.all([
        sessions.publicRooms(now),
        callActivityGames(await getUserLocale(user.id))
    ]);
    const open = rows.flatMap((row) => {
        const game = games.find((entry) => entry.id === row.game);
        if (!game || card.sessionEnded({ ...row, callEnded: false }, now)) return [];
        const players = row.players.filter((player) => card.stillPlaying(player, now)).length;
        if (players >= MAX_PLAYERS) return [];
        return [{ row, gameName: game.name, players }];
    });
    const hosts =
        open.length > 0
            ? await prisma.user.findMany({
                  where: { id: { in: [...new Set(open.map(({ row }) => row.startedById))] } },
                  select: { id: true, name: true }
              })
            : [];
    return {
        ok: true,
        rooms: open.map(({ row, gameName, players }) => ({
            id: row.id,
            game: row.game,
            gameName,
            host: {
                id: row.startedById,
                name: hosts.find((person) => person.id === row.startedById)?.name ?? ""
            },
            players,
            max: MAX_PLAYERS,
            href: card.lobbyHref(row.id)
        }))
    };
}
