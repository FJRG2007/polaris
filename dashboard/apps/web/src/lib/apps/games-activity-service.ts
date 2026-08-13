/**
 * Keeping a record of who played, out of the question something already asks.
 *
 * Polaris asks every game server who is on it once a minute, because that is how a
 * schedule knows whether a server has sat empty long enough to be let go. The answer
 * was used for that one decision and dropped. This keeps it, which is the whole
 * feature: the same exec, one more row.
 *
 * Which is also why the recording and the schedule sweep are one pass rather than
 * two. A second sweep on its own minute would ask every server all over again, and
 * asking is the expensive part - a command inside a container, for every server, for
 * a number that was already sitting in memory.
 *
 * Nothing here parses a log. A name that is on the roster now and was not a minute
 * ago has arrived; a name that has gone has left. That works for ARK, which prints
 * nothing worth reading, exactly as well as it does for Minecraft.
 */

import { prisma } from "@polaris/db";
import { patchInstallConfig } from "@/lib/apps/install-config";
import { listGameServerPresence } from "@/lib/apps/games-service";
import { NO_UPTIME, readServerUptime, uptimePatch, type ServerUptime } from "@/lib/apps/games-uptime";
import {
    fillGaps,
    historyOf,
    rosterChange,
    type OpenSession,
    type PlayerCount,
    type PlayerHistory
} from "@/lib/apps/games-activity";

/** How often the sweep asks, which is what a gap in the readings is measured
 *  against. Kept beside the readers rather than imported from the job, because it
 *  describes the data as written and not the cadence as configured. */
const SAMPLE_EVERY_MS = 60_000;

/**
 * How long the per-minute readings are kept.
 *
 * The same eight days the raw container metrics get, and for the same reason: this
 * is one row per server per minute, and past a week nobody asks a question it is the
 * only answer to. The visits outlive it by a long way - a session is one row per
 * player per sitting, which is small enough to keep for as long as the server does.
 */
const SAMPLE_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

/** And how long a finished visit is kept. */
const SESSION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** How often the sweep bothers to look for rows to drop. Cheap, but not free, and
 *  nothing here is urgent enough to pay for it every minute. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

let prunedAt = 0;

export interface ActivitySweep {
    /** What each server answered, for the schedule sweep that runs next: the count
     *  when it answered, null when it did not. Silence is not nought - a server that
     *  cannot be reached is not a server nobody is playing. */
    readonly known: Map<string, number | null>;
    readonly arrived: number;
    readonly left: number;
}

/**
 * Read every game server's roster once, and write down what changed.
 *
 * Per owner, like every other sweep here, and best effort throughout: a server that
 * cannot be reached is skipped rather than recorded as empty, and its open visits
 * are left open. A server that is genuinely unreachable for an hour will show one
 * long visit rather than sixty short ones, which is the more honest of the two
 * wrong answers available - and the gap in the readings says plainly that nobody
 * could see.
 */
export async function sweepGameActivity(ownerId: string, now: Date = new Date()): Promise<ActivitySweep> {
    const presences = await listGameServerPresence(ownerId).catch(() => []);
    const known = new Map<string, number | null>();
    let arrived = 0;
    let left = 0;

    // What each of them was last seen doing, read for the whole set in one query.
    // This sweep is the only thing that watches every server every minute, so it is
    // also the only thing in a position to notice one going up or down.
    const uptime = await readUptimes(presences.map((presence) => presence.id));

    for (const presence of presences) {
        known.set(presence.id, presence.answering ? presence.online : null);
        await recordUptime(presence.id, uptime.get(presence.id) ?? NO_UPTIME, presence.answering, now);

        // A container that is down is not a server anybody is on, and its visits
        // have to be closed rather than left running: an open visit counts up to
        // now, so a server switched off in March would still be adding playtime in
        // August. Not the same as merely not answering - that is a server still
        // starting, and its visits are left alone.
        if (!presence.answering) {
            if (presence.containerRunning === false) {
                await closeGameSessions(presence.id, now);
                await recordSample(presence.id, now, 0);
            }
            continue;
        }

        // The visits with no end are who was on when this last looked, so they are
        // both the history and the memory. Nothing else has to remember a roster.
        const open: OpenSession[] = await prisma.gamePlayerSession
            .findMany({
                where: { installedAppId: presence.id, leftAt: null },
                select: { id: true, name: true }
            })
            .catch(() => []);

        const change = rosterChange(
            open,
            presence.players.map((player) => player.name)
        );

        if (change.left.length > 0) {
            await prisma.gamePlayerSession
                .updateMany({ where: { id: { in: [...change.left] } }, data: { leftAt: now } })
                .catch(() => undefined);
            left += change.left.length;
        }
        if (change.arrived.length > 0) {
            await prisma.gamePlayerSession
                .createMany({
                    data: change.arrived.map((name) => ({ installedAppId: presence.id, name, joinedAt: now }))
                })
                .catch(() => undefined);
            arrived += change.arrived.length;
        }

        // Written even when nothing changed, and especially then: this row is the
        // evidence that anybody looked, which is what keeps a quiet night apart
        // from a night when the sweep was not running.
        await recordSample(presence.id, now, presence.online);
    }

    await pruneActivity(now);
    return { known, arrived, left };
}

/** One visit, as a screen reads it back. */
export interface VisitRow {
    readonly joinedAt: string;
    readonly leftAt: string | null;
}

/** Everything the history dialog shows about one player. */
export interface PlayerRecord {
    readonly history: PlayerHistory;
    /** Newest first, and bounded: this is a dialog, not the whole record. */
    readonly visits: readonly VisitRow[];
}

/** As many visits as a dialog can usefully show. */
const VISIT_LIMIT = 50;

/** What Polaris has watched this player do on this server. */
export async function readPlayerRecord(installedAppId: string, name: string, now: Date = new Date()): Promise<PlayerRecord> {
    const rows = await prisma.gamePlayerSession
        .findMany({
            where: { installedAppId, name: { equals: name, mode: "insensitive" } },
            select: { joinedAt: true, leftAt: true },
            orderBy: { joinedAt: "desc" }
        })
        .catch(() => []);

    return {
        history: historyOf(rows, now),
        visits: rows.slice(0, VISIT_LIMIT).map((row) => ({
            joinedAt: row.joinedAt.toISOString(),
            leftAt: row.leftAt?.toISOString() ?? null
        }))
    };
}

/** How many were playing, over a window, with the gaps kept as gaps. */
export async function readPlayerCounts(
    installedAppId: string,
    sinceMs: number,
    now: Date = new Date()
): Promise<PlayerCount[]> {
    const rows = await prisma.gameSample
        .findMany({
            where: { installedAppId, ts: { gte: new Date(now.getTime() - sinceMs) } },
            select: { ts: true, playersOnline: true },
            orderBy: { ts: "asc" }
        })
        .catch(() => []);
    return fillGaps(rows, SAMPLE_EVERY_MS);
}

/**
 * Close every visit on a server nobody is going to ask again.
 *
 * A server that is stopped, deleted or reset has people on it in the record forever
 * otherwise, and an open visit is counted up to now - so a server switched off in
 * March would still be adding playtime in August.
 */
export async function closeGameSessions(installedAppId: string, at: Date = new Date()): Promise<void> {
    await prisma.gamePlayerSession
        .updateMany({ where: { installedAppId, leftAt: null }, data: { leftAt: at } })
        .catch(() => undefined);
}

/** What every one of these servers was last seen doing, in one read. */
async function readUptimes(installedAppIds: readonly string[]): Promise<Map<string, ServerUptime>> {
    if (installedAppIds.length === 0) return new Map();
    const rows = await prisma.installedApp
        .findMany({ where: { id: { in: [...installedAppIds] } }, select: { id: true, config: true } })
        .catch(() => []);
    return new Map(rows.map((row) => [row.id, readServerUptime(row.config)]));
}

/** Write down that a server is up, came up, or has gone down - and nothing at all
 *  for one that is doing what it was doing a minute ago. */
async function recordUptime(
    installedAppId: string,
    current: ServerUptime,
    answering: boolean,
    now: Date
): Promise<void> {
    const patch = uptimePatch(current, answering, now);
    if (!patch) return;
    await patchInstallConfig(installedAppId, patch).catch(() => undefined);
}

/** One reading, and never a reason to fail the sweep around it. */
async function recordSample(installedAppId: string, ts: Date, playersOnline: number): Promise<void> {
    await prisma.gameSample.create({ data: { installedAppId, ts, playersOnline } }).catch(() => undefined);
}

/** Drop what is past keeping, occasionally rather than every minute. */
async function pruneActivity(now: Date): Promise<void> {
    if (now.getTime() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now.getTime();
    await prisma.gameSample
        .deleteMany({ where: { ts: { lt: new Date(now.getTime() - SAMPLE_RETENTION_MS) } } })
        .catch(() => undefined);
    // On when it started, not on when it ended, so that a visit left open by a
    // server that was deleted rather than stopped is eventually dropped too. There
    // is nothing left to close it.
    await prisma.gamePlayerSession
        .deleteMany({ where: { joinedAt: { lt: new Date(now.getTime() - SESSION_RETENTION_MS) } } })
        .catch(() => undefined);
}
