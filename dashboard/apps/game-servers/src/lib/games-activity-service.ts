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
 * Who is on decides the record: a name that is on the roster now and was not a
 * minute ago has arrived; a name that has gone has left. That works for ARK, which
 * prints nothing worth reading, exactly as well as it does for Minecraft. Where the
 * server does print its joins and leaves, they only decide when - the reconnect
 * that happened between two looks, and the moment rather than the minute.
 */

import { prisma, type Prisma } from "@polaris/db";
import { listGameServerPresence } from "./games-service";
import {
    NO_UPTIME,
    readServerUptime,
    uptimePatch,
    type ServerUptime,
    type UptimeReading
} from "./games-uptime";
import {
    fillGaps,
    historyOf,
    rosterChange,
    seenKey,
    sessionWrites,
    type LoggedConnection,
    type PlayerCount,
    type PlayerHistory,
    type PlayerSeen,
    type RosterPlayer,
    type TimedSession
} from "./games-activity";
import { host } from "@polaris/app-host";
import { keyedTurns } from "./turns";
import { logConnection, sessionsByPlayer, type PlayerSessionEvent } from "./minecraft/sessions";

const { patchInstallConfig } = host.appsInstallConfig;
const { announceActivity } = host.activityLive;

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
export async function sweepGameActivity(
    ownerId: string,
    now: Date = new Date()
): Promise<ActivitySweep> {
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
        await recordUptime(
            presence.id,
            uptime.get(presence.id) ?? NO_UPTIME,
            uptimeReading(presence),
            now
        );

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

        // Every minute the log is read as well, whenever anybody is or was on:
        // this pass looks once a minute, and somebody who dropped and came back
        // inside that minute is only in the log.
        const recorded = await recordRoster(presence.id, presence.players, now, {
            log: "always",
            readLog: () => readSessionLog(presence.id)
        });
        arrived += recorded.arrived;
        left += recorded.left;

        // Written even when nothing changed, and especially then: this row is the
        // evidence that anybody looked, which is what keeps a quiet night apart
        // from a night when the sweep was not running.
        await recordSample(presence.id, now, presence.online);
    }

    await pruneActivity(now);
    return { known, arrived, left };
}

/** What one recording did, and when each visit still open began. */
export interface RosterRecord {
    readonly arrived: number;
    readonly left: number;
    /** When the visit each player on is on began, by `seenKey`. */
    readonly since: ReadonlyMap<string, Date>;
}

/** The passes in flight, one per server, so two readers - the minute's sweep and
 *  a screen's live feed - never both open a visit for the same arrival, and no
 *  visit is opened from open rows a close has just ended. */
const inTurn = keyedTurns();

/**
 * Write down what changed on one server since it was last looked at.
 *
 * Shared by the minute's sweep and by the live feed a screen holds open, so that
 * who is on and since when is as fresh as whatever is looking - every few seconds
 * while somebody watches, every minute while nobody does. One at a time per
 * server: two passes reading the same open visits would both see the same arrival.
 *
 * `readLog` is the server's own record of joins and leaves, for the games that
 * keep one. The sweep reads it on every pass, because between two of its looks a
 * reconnect leaves no other trace; the live feed only when something changed,
 * because reading a log every few seconds costs more than the answer is worth.
 */
export async function recordRoster(
    installedAppId: string,
    players: readonly RosterPlayer[],
    now: Date,
    options: {
        readonly readLog?: () => Promise<readonly PlayerSessionEvent[] | null>;
        readonly log?: "always" | "changes";
    } = {}
): Promise<RosterRecord> {
    return inTurn(installedAppId, () => writeRoster(installedAppId, players, now, options));
}

async function writeRoster(
    installedAppId: string,
    players: readonly RosterPlayer[],
    now: Date,
    options: {
        readonly readLog?: () => Promise<readonly PlayerSessionEvent[] | null>;
        readonly log?: "always" | "changes";
    }
): Promise<RosterRecord> {
    // The visits with no end are who was on when this last looked, so they are
    // both the history and the memory. Nothing else has to remember a roster.
    // Oldest first, so that of two left open by an interrupted pass the one kept
    // is the one that began the visit.
    const open: TimedSession[] = await prisma.gamePlayerSession
        .findMany({
            where: { installedAppId, leftAt: null },
            select: { id: true, name: true, playerId: true, joinedAt: true },
            orderBy: { joinedAt: "asc" }
        })
        .catch(() => []);

    // The roster as the game answered it, id and all: on ARK that id is the
    // only half of it that is the person.
    const change = rosterChange(open, players);
    const changed = change.arrived.length > 0 || change.left.length > 0;
    const wantsLog =
        options.readLog !== undefined &&
        (options.log === "always" ? open.length > 0 || players.length > 0 : changed);
    const events = wantsLog ? await options.readLog!().catch(() => null) : null;
    const writes = sessionWrites(open, change, players, events ? connections(events) : null, now);

    // A visit that was open when the id started being kept: the game has just
    // said whose it is, so the row is told before it closes and stops being
    // findable by anything but a name the list may not hold.
    for (const row of change.adopted) {
        await prisma.gamePlayerSession
            .updateMany({ where: { id: row.id, playerId: null }, data: { playerId: row.playerId } })
            .catch(() => undefined);
    }

    // One write per distinct time, which is one for the whole set whenever the
    // log had nothing to add.
    const byTime = new Map<number, string[]>();
    for (const row of writes.close) {
        const held = byTime.get(row.leftAt.getTime());
        if (held) held.push(row.id);
        else byTime.set(row.leftAt.getTime(), [row.id]);
    }
    for (const [time, ids] of byTime) {
        await prisma.gamePlayerSession
            .updateMany({
                where: { id: { in: ids }, leftAt: null },
                data: { leftAt: new Date(time) }
            })
            .catch(() => undefined);
    }
    if (writes.open.length > 0) {
        await prisma.gamePlayerSession
            .createMany({
                data: writes.open.map((row) => ({
                    installedAppId,
                    name: row.player.name,
                    playerId: row.player.id,
                    joinedAt: row.joinedAt
                }))
            })
            .catch(() => undefined);
    }

    // Whoever arrived or left may be somebody's account, and their card says
    // "Playing Minecraft" or stops saying it: their screens are told now
    // rather than at the next presence refresh. A reconnect counts, because the
    // card says since when. Best effort - the card is right within a minute
    // either way.
    if (writes.close.length > 0 || writes.open.length > 0) {
        const closed = new Set(writes.close.map((row) => row.id));
        const names = [
            ...writes.open.map((row) => row.player.name),
            ...open.filter((row) => closed.has(row.id)).map((row) => row.name)
        ];
        await announcePlayers(installedAppId, [...new Set(names)]);
    }

    // When each visit still open began, for a live feed that says so.
    const since = new Map<string, Date>();
    const reopened = new Set(writes.close.map((row) => row.id));
    for (const row of open) {
        if (reopened.has(row.id)) continue;
        const key = seenKey({ name: row.name, id: row.playerId });
        if (!since.has(key)) since.set(key, row.joinedAt);
    }
    for (const row of writes.open) since.set(seenKey(row.player), row.joinedAt);

    return { arrived: change.arrived.length, left: change.left.length, since };
}

/** The log's joins and leaves, as each player's connection stands. */
function connections(events: readonly PlayerSessionEvent[]): Map<string, LoggedConnection> {
    const found = new Map<string, LoggedConnection>();
    for (const [key, own] of sessionsByPlayer(events)) {
        const connection = logConnection(own);
        const stamp = (iso: string | null): Date | null => {
            if (!iso) return null;
            const at = new Date(iso);
            return Number.isNaN(at.getTime()) ? null : at;
        };
        found.set(key, {
            online: connection.online,
            since: stamp(connection.since),
            lastLeft: stamp(connection.lastLeft)
        });
    }
    return found;
}

/** The server's log of joins and leaves, for the servers that print one, and
 *  null for every other: reading it is a container's log, so it is only done
 *  where there is something to read. */
export async function readSessionLog(
    installedAppId: string
): Promise<readonly PlayerSessionEvent[] | null> {
    const { getPlayerSessionsIfMinecraft } = await import("./minecraft/service");
    return getPlayerSessionsIfMinecraft(installedAppId);
}

/** Tell the screens drawing these players' accounts that they arrived or left.
 *  Never a reason to fail the sweep. */
async function announcePlayers(installedAppId: string, names: readonly string[]): Promise<void> {
    try {
        const { accountsOfPlayers } = await import("./minecraft/playing-now");
        const accounts = await accountsOfPlayers(installedAppId, names);
        if (accounts.length > 0) await announceActivity(accounts);
    } catch {
        // The presence refresh picks it up within a minute.
    }
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

/**
 * The rows a visit of this player's could have been written under.
 *
 * The id where the game reports one, and the name for the rows written before it
 * did - on ARK that is every visit recorded under a survivor name, which is the
 * only thing there ever was to match on. Once a row carries an id, that id is who
 * it belongs to and the name no longer decides anything: two survivors can share
 * a name, and handing one of them the other's history would be worse than saying
 * nothing.
 *
 * Names are compared as they are spelled, which is what the index on them can
 * answer: this runs for a whole table of players on a poll, and matching a few
 * hundred names without case would mean reading every visit the server has ever
 * had. `readPlayerRecord` below, which is about one person and runs when a dialog
 * opens, can afford the other comparison and does.
 */
function visitsOf(players: readonly RosterPlayer[]): Prisma.GamePlayerSessionWhereInput[] {
    const ids = [
        ...new Set(players.map((player) => player.id?.trim()).filter((id): id is string => !!id))
    ];
    const names = [
        ...new Set(players.map((player) => player.name.trim()).filter((name) => name.length > 0))
    ];
    const or: Prisma.GamePlayerSessionWhereInput[] = [];
    if (ids.length > 0) or.push({ playerId: { in: ids } });
    if (names.length > 0) or.push({ playerId: null, name: { in: names } });
    return or;
}

/**
 * When each of these players was last on this server.
 *
 * For the second line of a players table, which used to say when a row was added
 * to the allow list - a fact about the list rather than about the person, and one
 * nobody asks. What is actually wanted is "playing for two hours" or "last on
 * yesterday", and for ARK that answer exists nowhere but here: the game reports
 * who is connected this second and nothing about a minute ago, so Polaris's own
 * record of who it has watched is the whole of what can be said.
 *
 * One grouped query for the whole table rather than one per row. Filed under the
 * id where there is one and under the name where there is not, because a row is
 * drawn under whichever name the list it came from holds - on ARK the label
 * somebody typed - and the visit was recorded under whatever the server called
 * them, which is a different name entirely.
 */
export async function readLastSeen(
    installedAppId: string,
    players: readonly RosterPlayer[]
): Promise<Record<string, PlayerSeen>> {
    const or = visitsOf(players);
    if (or.length === 0) return {};
    const [rows, open] = await Promise.all([
        prisma.gamePlayerSession
            .groupBy({
                by: ["name", "playerId"],
                where: { installedAppId, OR: or },
                _max: { joinedAt: true, leftAt: true }
            })
            .catch(() => []),
        // The visits still open, apart: the newest start of all of them is only
        // the one they are on when that one is open, and the newest end is the
        // visit before it - neither is "playing since".
        prisma.gamePlayerSession
            .groupBy({
                by: ["name", "playerId"],
                where: { installedAppId, leftAt: null, OR: or },
                _max: { joinedAt: true }
            })
            .catch(() => [])
    ]);

    const found: Record<string, PlayerSeen> = {};
    const file = (
        key: string,
        since: Date | null,
        lastSeen: Date | null,
        current: Date | null
    ): void => {
        // A player has one row per name they have played under, so the newest of
        // them is the answer rather than whichever the database returned last.
        const held = found[key];
        found[key] = {
            since: newest(held?.since ?? null, since?.toISOString() ?? null),
            lastSeen: newest(held?.lastSeen ?? null, lastSeen?.toISOString() ?? null),
            open: newest(held?.open ?? null, current?.toISOString() ?? null)
        };
    };
    const openOf = new Map(
        open.map((row) => [`${row.name}\u0000${row.playerId ?? ""}`, row._max.joinedAt ?? null])
    );
    for (const row of rows) {
        const since = row._max.joinedAt ?? null;
        const left = row._max.leftAt ?? null;
        const current = openOf.get(`${row.name}\u0000${row.playerId ?? ""}`) ?? null;
        if (row.playerId) file(seenKey({ name: row.name, id: row.playerId }), since, left, current);
        // Filed under the name as well, so a row still finds it under the name it
        // is drawn with when the game has no id to look it up by.
        file(seenKey({ name: row.name, id: null }), since, left, current);
    }
    return found;
}

/** The later of two stamps, either of which may be missing. */
function newest(left: string | null, right: string | null): string | null {
    if (!left) return right;
    if (!right) return left;
    return left > right ? left : right;
}

/** What Polaris has watched this player do on this server. */
export async function readPlayerRecord(
    installedAppId: string,
    player: RosterPlayer,
    now: Date = new Date()
): Promise<PlayerRecord> {
    const rows = await prisma.gamePlayerSession
        .findMany({
            where: {
                installedAppId,
                OR: [
                    ...(player.id ? [{ playerId: player.id }] : []),
                    // Without case, because the lists disagree on it: a visit is
                    // recorded as the server spelled the name and a row is opened
                    // from the list, which holds whatever was typed into it.
                    { playerId: null, name: { equals: player.name, mode: "insensitive" as const } }
                ]
            },
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
export async function closeGameSessions(
    installedAppId: string,
    at: Date = new Date()
): Promise<void> {
    return inTurn(installedAppId, () => closeOpenSessions(installedAppId, at));
}

async function closeOpenSessions(installedAppId: string, at: Date): Promise<void> {
    const open = await prisma.gamePlayerSession
        .findMany({ where: { installedAppId, leftAt: null }, select: { id: true, name: true } })
        .catch(() => []);
    if (open.length === 0) return;
    await prisma.gamePlayerSession
        .updateMany({ where: { id: { in: open.map((row) => row.id) } }, data: { leftAt: at } })
        .catch(() => undefined);
    await announcePlayers(
        installedAppId,
        open.map((row) => row.name)
    );
}

/** What every one of these servers was last seen doing, in one read. */
async function readUptimes(installedAppIds: readonly string[]): Promise<Map<string, ServerUptime>> {
    if (installedAppIds.length === 0) return new Map();
    const rows = await prisma.installedApp
        .findMany({
            where: { id: { in: [...installedAppIds] } },
            select: { id: true, config: true }
        })
        .catch(() => []);
    return new Map(rows.map((row) => [row.id, readServerUptime(row.config)]));
}

/**
 * What this reading establishes about whether the server is up.
 *
 * The same distinction the visits are kept on, and for the same reason: a server
 * that did not answer has not been seen going down, it has not been seen at all.
 * Only a container that is known to be stopped ends a run.
 */
function uptimeReading(presence: {
    readonly answering: boolean;
    readonly containerRunning: boolean | null;
}): UptimeReading {
    if (presence.answering) return "up";
    return presence.containerRunning === false ? "down" : "unknown";
}

/** Write down that a server is up, came up, or has gone down - and nothing at all
 *  for one that is doing what it was doing a minute ago. */
async function recordUptime(
    installedAppId: string,
    current: ServerUptime,
    reading: UptimeReading,
    now: Date
): Promise<void> {
    const patch = uptimePatch(current, reading, now);
    if (!patch) return;
    await patchInstallConfig(installedAppId, patch).catch(() => undefined);
}

/** One reading, and never a reason to fail the sweep around it. */
async function recordSample(
    installedAppId: string,
    ts: Date,
    playersOnline: number
): Promise<void> {
    await prisma.gameSample
        .create({ data: { installedAppId, ts, playersOnline } })
        .catch(() => undefined);
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

/** One player somebody has watched on a server, for the assistant's search. */
export interface KnownPlayer {
    readonly installedAppId: string;
    /** As the server spells it. */
    readonly name: string;
    /** The game's own id where it has one (an ARK survivor's SteamID64). */
    readonly playerId: string | null;
    /** When they were last on, or on now (`leftAt` null). */
    readonly lastSeen: string;
    readonly online: boolean;
}

/**
 * The players these servers have seen, most recently seen first: those whose
 * name holds `query` first, then the rest, so the ranking that comes after has
 * candidates whose name is spelt differently. Bounded by `limit` in the
 * database - a server that has had ten thousand visitors is not read whole for
 * a search.
 */
export async function searchKnownPlayers(
    installedAppIds: readonly string[],
    query: string,
    limit: number
): Promise<KnownPlayer[]> {
    if (installedAppIds.length === 0 || limit <= 0) return [];
    const within = { installedAppId: { in: [...installedAppIds] } };
    const read = (where: Prisma.GamePlayerSessionWhereInput, take: number) =>
        prisma.gamePlayerSession.groupBy({
            by: ["installedAppId", "name", "playerId"],
            where,
            _max: { joinedAt: true },
            orderBy: { _max: { joinedAt: "desc" } },
            take
        });
    const wanted = query.trim();
    const matched = wanted
        ? await read({ ...within, name: { contains: wanted, mode: "insensitive" } }, limit)
        : [];
    const rest = matched.length < limit ? await read(within, limit) : [];
    const seen = new Set<string>();
    const rows = [...matched, ...rest].filter((row) => {
        const key = `${row.installedAppId}\u0000${row.name.toLowerCase()}\u0000${row.playerId ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const picked = rows.slice(0, limit);
    const open = picked.length
        ? await prisma.gamePlayerSession.findMany({
              where: {
                  leftAt: null,
                  OR: picked.map((row) => ({ installedAppId: row.installedAppId, name: row.name }))
              },
              select: { installedAppId: true, name: true }
          })
        : [];
    const on = new Set(open.map((row) => `${row.installedAppId}\u0000${row.name}`));
    return picked.map((row) => ({
        installedAppId: row.installedAppId,
        name: row.name,
        playerId: row.playerId,
        lastSeen: (row._max.joinedAt ?? new Date(0)).toISOString(),
        online: on.has(`${row.installedAppId}\u0000${row.name}`)
    }));
}
