/**
 * What somebody is doing, written by the things that observe it and read for the
 * faces that show it.
 *
 * Writers: the desktop app (a game running), the music service poll (a track
 * playing). Each owns one row per account, replaced as it changes. The game
 * servers app is a reader-side source instead - it already records who is on,
 * so a Minecraft session is looked up rather than copied here.
 *
 * Reading applies everything a reader is owed, in one place, so no screen can
 * forget a part of it: the `activity` audience, the master and per-source
 * switches, the hidden games, and each row's own lapse. The caller has already
 * decided the person is visibly here - see `presenceFor`, which only asks about
 * people it is not drawing as offline.
 *
 * A change is announced (`announceActivity`) only when it is one a reader would
 * see - a new game, the next song, a seek - never on the heartbeat that merely
 * keeps a row alive, which is most writes.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { announceActivity } from "./live";
import { allowedBy } from "@/lib/privacy-service";
import { playingNowFor } from "@/lib/app-extensions/registry";
import { activitySettingsFor, activitySettingsOf, rememberSeenGame } from "./settings";

/** The sources that are stored here rather than looked up. */
export type StoredSource = Extract<core.ActivitySource, "spotify" | "game">;

/**
 * How long a reported game is believed without being reported again.
 *
 * The desktop app says it again every minute while the game runs, so three is
 * two missed reports - a network blip - before "Playing" goes away, and a
 * computer that was switched off stops claiming anything within three minutes.
 */
export const GAME_REPORT_TTL_MS = 3 * 60_000;

/** The furthest back a reported start may be. A claim of a game running for a
 *  month is a clock that is wrong, and a week is past any real session. */
const OLDEST_START_MS = 7 * 24 * 60 * 60_000;

/** How far a start may move before it is news rather than two clocks
 *  disagreeing: past this, a track was sought, or a game restarted. */
const START_DRIFT_MS = 5_000;

/** One activity as it is stored. */
export interface StoredActivity {
    readonly key: string;
    readonly name: string;
    readonly details?: string;
    readonly state?: string;
    readonly imageUrl?: string | null;
    readonly linkUrl?: string | null;
    readonly startedAt: Date;
    readonly endsAt?: Date | null;
}

/**
 * Whether a reader would see a difference between these two.
 *
 * The lapse is not part of it - pushing it forward is the heartbeat - and a
 * start that moved by a few seconds is two clocks, not a seek.
 */
export function activityChanged(
    before: {
        key: string;
        name: string;
        details: string;
        state: string;
        imageUrl: string | null;
        startedAt: Date;
        expiresAt: Date;
    } | null,
    next: StoredActivity,
    now: Date
): boolean {
    if (!before || before.expiresAt <= now) return true;
    return (
        before.key !== next.key ||
        before.name !== next.name ||
        before.details !== (next.details ?? "") ||
        before.state !== (next.state ?? "") ||
        before.imageUrl !== (next.imageUrl ?? null) ||
        Math.abs(before.startedAt.getTime() - next.startedAt.getTime()) > START_DRIFT_MS
    );
}

/**
 * Write what somebody is doing from one source, and announce it when it is news.
 * Answers whether it was.
 */
export async function putActivity(
    userId: string,
    source: StoredSource,
    next: StoredActivity,
    expiresAt: Date,
    now: Date = new Date()
): Promise<boolean> {
    const before = await prisma.userActivity.findUnique({
        where: { userId_source: { userId, source } },
        select: {
            key: true,
            name: true,
            details: true,
            state: true,
            imageUrl: true,
            startedAt: true,
            expiresAt: true
        }
    });
    const data = {
        key: next.key,
        name: next.name,
        details: next.details ?? "",
        state: next.state ?? "",
        imageUrl: next.imageUrl ?? null,
        linkUrl: next.linkUrl ?? null,
        startedAt: next.startedAt,
        endsAt: next.endsAt ?? null,
        expiresAt
    };
    await prisma.userActivity.upsert({
        where: { userId_source: { userId, source } },
        create: { userId, source, ...data },
        update: data
    });
    const news = activityChanged(before, next, now);
    if (news) await announceActivity([userId]);
    return news;
}

/** Stop showing one source. Announced only when there was something showing. */
export async function clearActivity(
    userId: string,
    source: StoredSource,
    now: Date = new Date()
): Promise<void> {
    const row = await prisma.userActivity.findUnique({
        where: { userId_source: { userId, source } },
        select: { expiresAt: true }
    });
    if (!row) return;
    const gone = await prisma.userActivity.deleteMany({
        where: { userId, source, expiresAt: row.expiresAt }
    });
    // A row already past its lapse is tidied too, silently: no reader was being
    // shown it.
    if (gone.count > 0 && row.expiresAt > now) await announceActivity([userId]);
}

/** What happened to a report from the desktop app. */
export interface GameReportOutcome {
    /** Whether it is being shown to anybody. */
    readonly shown: boolean;
    /** Why not, in the words the desktop app shows its owner. */
    readonly reason?: "none" | "off" | "hidden";
}

/**
 * A report from the desktop app: this game is running, or nothing is.
 *
 * A game is remembered while games are shared at all - shown or hidden - so it
 * can be hidden (or shown again) by name from the settings screen after it has
 * been closed. With sharing off nothing is kept: somebody who said "do not share
 * my games" did not ask for a list of them either. What
 * the switches say is applied here as well as on read: a game that is hidden is
 * never stored, so it cannot surface through anything that forgets to check.
 */
export async function reportGame(
    userId: string,
    report: core.GameReport,
    now: Date = new Date()
): Promise<GameReportOutcome> {
    const game = report.game;
    if (!game) {
        await clearActivity(userId, "game", now);
        return { shown: false, reason: "none" };
    }
    const { settings } = await activitySettingsOf(userId);
    if (!core.activitySourceOn(settings, "game")) {
        await clearActivity(userId, "game", now);
        return { shown: false, reason: "off" };
    }
    await rememberSeenGame(userId, game, now);
    if (settings.hiddenGames.includes(game.key)) {
        await clearActivity(userId, "game", now);
        return { shown: false, reason: "hidden" };
    }
    const claimed = Date.parse(game.startedAt);
    const startedAt = new Date(
        Math.min(now.getTime(), Math.max(now.getTime() - OLDEST_START_MS, claimed))
    );
    await putActivity(
        userId,
        "game",
        { key: game.key, name: game.name, startedAt },
        new Date(now.getTime() + GAME_REPORT_TTL_MS),
        now
    );
    return { shown: true };
}

/** The order cards are drawn in: a game before music, as people expect. */
const ORDER: Record<core.ActivitySource, number> = { minecraft: 0, game: 1, spotify: 2 };

/**
 * What each of these people is doing, as this reader may be told.
 *
 * Only ever asked about people the caller is drawing as here: somebody offline
 * or invisible to this reader is doing nothing as far as they know, and that
 * rule lives in the caller because it is the one that decided the dot.
 */
export async function activitiesFor(
    viewer: { id: string; isAdmin: boolean },
    ids: readonly string[],
    now: Date = new Date()
): Promise<Map<string, core.ActivityView[]>> {
    const answer = new Map<string, core.ActivityView[]>();
    const wanted = [...new Set(ids.filter(Boolean))];
    if (wanted.length === 0) return answer;

    const allowed = await allowedBy(viewer, "activity", wanted);
    const shown = wanted.filter((id) => allowed.has(id));
    if (shown.length === 0) return answer;

    const settings = await activitySettingsFor(shown);
    const sharing = shown.filter((id) => settings.get(id)?.share ?? true);
    if (sharing.length === 0) return answer;
    const onMinecraft = sharing.filter((id) =>
        core.activitySourceOn(settings.get(id) ?? core.DEFAULT_ACTIVITY_SETTINGS, "minecraft")
    );

    const [rows, playing] = await Promise.all([
        prisma.userActivity.findMany({
            where: { userId: { in: sharing }, expiresAt: { gt: now } },
            select: {
                userId: true,
                source: true,
                key: true,
                name: true,
                details: true,
                state: true,
                imageUrl: true,
                linkUrl: true,
                startedAt: true,
                endsAt: true
            }
        }),
        playingNowFor(onMinecraft).catch(() => new Map())
    ]);

    for (const row of rows) {
        const source = row.source as core.ActivitySource;
        if (source !== "spotify" && source !== "game") continue;
        const own = settings.get(row.userId) ?? core.DEFAULT_ACTIVITY_SETTINGS;
        if (!core.activitySourceOn(own, source)) continue;
        if (source === "game" && own.hiddenGames.includes(row.key)) continue;
        push(answer, row.userId, {
            source,
            key: row.key,
            name: row.name,
            details: row.details,
            state: row.state,
            imageUrl: row.imageUrl,
            linkUrl: row.linkUrl,
            startedAt: row.startedAt.toISOString(),
            endsAt: row.endsAt?.toISOString() ?? null
        });
    }
    for (const [userId, visit] of playing) {
        push(answer, userId, {
            source: "minecraft",
            key: `server:${visit.server}`,
            name: visit.game,
            details: visit.server,
            state: "",
            imageUrl: null,
            linkUrl: null,
            startedAt: visit.since.toISOString(),
            endsAt: null
        });
    }
    for (const [userId, list] of answer) {
        // Playing Minecraft on a server here is also Minecraft running on their
        // computer, and one person playing one game is one card - the one that
        // knows which server.
        const onServer = new Set(
            list.filter((view) => view.source === "minecraft").map((view) => view.name.toLowerCase())
        );
        const kept = list.filter(
            (view) => view.source !== "game" || !onServer.has(view.name.toLowerCase())
        );
        kept.sort((a, b) => ORDER[a.source] - ORDER[b.source]);
        answer.set(userId, kept);
    }
    return answer;
}

function push(into: Map<string, core.ActivityView[]>, userId: string, view: core.ActivityView): void {
    const list = into.get(userId);
    if (list) list.push(view);
    else into.set(userId, [view]);
}
