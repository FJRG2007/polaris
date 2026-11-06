/**
 * What somebody did lately, for the "Recent activity" list on their profile.
 *
 * Only what Polaris itself keeps a record of after it has ended: a visit to a
 * game server here (the game servers app's sessions, through its extension) and
 * a game played together in the Games app. A game the desktop app saw running or
 * a song on a music service leaves nothing behind once it stops - its row is
 * deleted - so it is never listed here, and nothing is guessed in its place.
 *
 * The same rules as what they are doing now (`activitiesFor`): the person's
 * `activity` audience, their switch for sharing at all, and the switch for each
 * source. On top of those, nothing at all while they have chosen to be
 * invisible: a visit that ended a minute ago would say they are around.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { activitySettingsFor } from "./settings";
import { allowedBy } from "@/lib/privacy-service";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { callActivityGames, playedRecentlyFor } from "@/lib/app-extensions/registry";

/** How far back "recent" reaches. */
export const RECENT_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** How many entries the list shows. */
export const RECENT_LIMIT = 5;
/** The most ended Games app seats read to find the last few games. */
const MOST_ENDED_SEATS = 50;

/** One thing somebody did lately, as the list draws it. Dates are ISO. */
export interface RecentActivityView {
    readonly source: Extract<core.ActivitySource, "minecraft" | "game">;
    /** Stable per entry: one per server, one per game. */
    readonly key: string;
    /** The game, as people call it. */
    readonly name: string;
    /** The server it was played on, empty for a game played together. */
    readonly details: string;
    readonly imageUrl: string | null;
    readonly gameId: string | null;
    /** When it ended. */
    readonly endedAt: string;
}

export async function recentActivityFor(
    viewer: { id: string; isAdmin: boolean },
    personId: string,
    now: Date = new Date()
): Promise<RecentActivityView[]> {
    const self = viewer.id === personId;
    const [allowed, settings, person] = await Promise.all([
        self ? Promise.resolve(new Set([personId])) : allowedBy(viewer, "activity", [personId]),
        activitySettingsFor([personId]),
        prisma.user.findUnique({
            where: { id: personId },
            select: { presence: true, presenceUntil: true }
        })
    ]);
    if (!person || !allowed.has(personId)) return [];
    const own = settings.get(personId) ?? core.DEFAULT_ACTIVITY_SETTINGS;
    if (!own.share) return [];
    if (!self && invisible(person, now)) return [];

    const since = new Date(now.getTime() - RECENT_WINDOW_MS);
    const [servers, together] = await Promise.all([
        core.activitySourceOn(own, "minecraft")
            ? playedRecentlyFor(personId, since, RECENT_LIMIT)
            : Promise.resolve([]),
        core.activitySourceOn(own, "game")
            ? playedTogetherRecently(viewer.id, personId, since).catch(() => [])
            : Promise.resolve([])
    ]);

    const list: RecentActivityView[] = [
        ...servers.map((visit) => ({
            source: "minecraft" as const,
            key: `server:${visit.installedAppId}`,
            name: visit.game,
            details: visit.server,
            imageUrl: visit.imageUrl ?? null,
            gameId: visit.gameId ?? null,
            endedAt: visit.endedAt.toISOString()
        })),
        ...together
    ];
    return list.sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, RECENT_LIMIT);
}

/** Invisible by their own choice, and not yet past the time they set it for. */
function invisible(person: { presence: string; presenceUntil: Date | null }, now: Date): boolean {
    return (
        person.presence === "invisible" &&
        (person.presenceUntil === null || person.presenceUntil > now)
    );
}

/**
 * Games played together here that have ended, the last of each game. The game's
 * name is the catalog's, in the reader's language; a game no longer offered is
 * left out rather than shown by an id.
 */
async function playedTogetherRecently(
    viewerId: string,
    personId: string,
    since: Date
): Promise<RecentActivityView[]> {
    if (!(await isAppInstalled("arcade"))) return [];
    const seats = await prisma.arcadeSessionPlayer.findMany({
        where: { userId: personId, leftAt: { gte: since } },
        select: { leftAt: true, session: { select: { game: true } } },
        orderBy: { leftAt: "desc" },
        take: MOST_ENDED_SEATS
    });
    if (seats.length === 0) return [];
    const games = await callActivityGames(await getUserLocale(viewerId));
    const found: RecentActivityView[] = [];
    for (const seat of seats) {
        if (!seat.leftAt || found.some((entry) => entry.key === `arcade:${seat.session.game}`)) {
            continue;
        }
        const game = games.find((entry) => entry.id === seat.session.game);
        if (!game) continue;
        found.push({
            source: "game",
            key: `arcade:${seat.session.game}`,
            name: game.name,
            details: "",
            imageUrl: null,
            gameId: null,
            endedAt: seat.leftAt.toISOString()
        });
        if (found.length >= RECENT_LIMIT) break;
    }
    return found;
}
