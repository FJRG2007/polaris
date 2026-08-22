/**
 * Who played, when, and how many were on - worked out from two rosters at a time.
 *
 * The joins and the leaves were always in the container's log, and were read back
 * out of it whenever somebody opened the screen. That is a fine way to answer "who
 * is here" and a poor way to answer "who plays on this server", because the log
 * reaches back only as far as the tail that was asked for and starts again empty
 * every time the container is replaced. An evening somebody wanted to look back on
 * was gone by the weekend.
 *
 * So instead of reading prose, this compares rosters. Something asks the server who
 * is on, once a minute, in whatever language that game speaks; a name that was not
 * there a minute ago is an arrival, and a name that has gone is a departure. It
 * needs no log format, which is what lets ARK have a history at all - it prints
 * nothing anybody should be parsing - and it means one rule covers both games.
 *
 * Pure, so all of it can be tested without a container: the impure half that does
 * the asking and the writing is `games-activity-service.ts`.
 */

/** Somebody on a roster: the name the server printed, and the id it printed
 *  beside it for the games that have one. */
export interface RosterPlayer {
    readonly name: string;
    /** ARK's SteamID64. Null on Minecraft, where the name is the identity. */
    readonly id: string | null;
}

/** A visit that has not ended: who, since when, and the row it belongs to. */
export interface OpenSession {
    readonly id: string;
    readonly name: string;
    /** The player it belongs to, for a visit recorded since the game's own id was
     *  kept. Null on Minecraft and on every row written before it was. */
    readonly playerId: string | null;
}

/** What changed between the roster last seen and the roster now. */
export interface RosterChange {
    /** Players to start a session for. */
    readonly arrived: readonly RosterPlayer[];
    /** Sessions to close, by id. */
    readonly left: readonly string[];
    /** Visits still open that the game has now said whose they are: recorded
     *  under a name alone, before the id was kept, and matched by that name this
     *  pass. Writing the id on them is what stops the visit somebody is on right
     *  now from being lost to their row the moment it ends. */
    readonly adopted: readonly { readonly id: string; readonly playerId: string }[];
}

/**
 * Fold a fresh roster against the sessions still open into arrivals and departures.
 *
 * Matched on the game's own id wherever there is one. On ARK the name is the
 * survivor's, which can be changed at will and which two people can both pick, so
 * a name is neither stable enough to follow somebody through a visit nor unique
 * enough to tell two of them apart - and the id is printed on the same line.
 *
 * Where there is no id - Minecraft, and every visit recorded before the id was
 * kept - names are matched without case, because how a name is capitalised is the
 * server's business and not always the same answer twice: a roster that comes back
 * differently cased would otherwise read as everybody leaving and immediately
 * rejoining. The name as it arrives is what gets stored, so the newest spelling is
 * the one shown.
 *
 * Duplicates on either side are tolerated rather than trusted: two open sessions for
 * one player means an earlier sweep was interrupted, and closing all but one is how
 * that heals rather than something to refuse.
 */
export function rosterChange(open: readonly OpenSession[], roster: readonly RosterPlayer[]): RosterChange {
    const here = new Map<string, RosterPlayer>();
    /** Lowercased name to whoever holds it, for the sessions with no id to match on. */
    const byName = new Map<string, string>();
    for (const player of roster) {
        const name = player.name.trim();
        if (name.length === 0) continue;
        const id = player.id?.trim() || null;
        const key = id ?? name.toLowerCase();
        if (here.has(key)) continue;
        here.set(key, { name, id });
        if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), key);
    }

    const kept = new Set<string>();
    const left: string[] = [];
    const adopted: { id: string; playerId: string }[] = [];
    for (const session of open) {
        // A session that knows whose it is is matched on that alone: falling back to
        // the name would hand it to whoever is playing under that name now, which on
        // ARK need not be the same person.
        const key = session.playerId
            ? here.has(session.playerId)
                ? session.playerId
                : null
            : (byName.get(session.name.trim().toLowerCase()) ?? null);
        // Still on, and this is the first session claiming so. A second one is a
        // duplicate from an interrupted sweep and is closed.
        if (key !== null && !kept.has(key)) {
            kept.add(key);
            const id = here.get(key)?.id ?? null;
            if (id && !session.playerId) adopted.push({ id: session.id, playerId: id });
        } else left.push(session.id);
    }

    return {
        arrived: [...here.entries()].filter(([key]) => !kept.has(key)).map(([, player]) => player),
        left,
        adopted
    };
}

/** When one player was last on, for the line under their row. */
export interface PlayerSeen {
    /** When their latest visit started - which is when they arrived, for
     *  somebody who is still playing. */
    readonly since: string | null;
    /** When they were last seen leaving. Null for somebody whose only visit is
     *  the one they are on. */
    readonly lastSeen: string | null;
}

/**
 * How a visit is filed and looked up in one pass of `readLastSeen`.
 *
 * The id where the game has one, and the lowercased name where it does not.
 * Prefixed, so that a survivor named after a Steam id cannot be handed somebody
 * else's history.
 */
export function seenKey(player: RosterPlayer): string {
    return player.id ? `#${player.id}` : `@${player.name.trim().toLowerCase()}`;
}

/**
 * What is known about when this row's player was last on.
 *
 * A row is drawn under whichever name the list it came from holds, and the visit
 * was recorded under whatever the server called them at the time, so more than one
 * name can lead to the same person. The id is tried first because it is the only
 * one of them that is the person.
 */
export function seenFor(
    seen: Readonly<Record<string, PlayerSeen>>,
    player: { readonly id: string | null; readonly names: readonly string[] }
): PlayerSeen | null {
    const keys = [
        ...(player.id ? [seenKey({ name: "", id: player.id })] : []),
        ...player.names.filter((name) => name.trim().length > 0).map((name) => seenKey({ name, id: null }))
    ];
    for (const key of keys) {
        const found = seen[key];
        if (found) return found;
    }
    return null;
}

/** One visit, as the history reads it back. */
export interface PlayerVisit {
    readonly joinedAt: Date;
    /** Open while they are still on. */
    readonly leftAt: Date | null;
}

/** What is worth saying about somebody, over every visit they have made. */
export interface PlayerHistory {
    readonly visits: number;
    readonly firstSeen: Date | null;
    /** When they were last on - now, if they still are. */
    readonly lastSeen: Date | null;
    /** Total time on the server, counting the current visit. */
    readonly playedMs: number;
    /** The visit in progress, if there is one. */
    readonly online: boolean;
    /** How long the longest single visit lasted. */
    readonly longestMs: number;
}

/**
 * Everything the history screen says about one player, from their visits.
 *
 * An open visit is counted up to `now` rather than skipped: somebody who has been
 * on for three hours has played for three hours, and a total that only moves when
 * they leave reads as broken to the person watching it.
 */
export function historyOf(visits: readonly PlayerVisit[], now: Date): PlayerHistory {
    if (visits.length === 0) {
        return { visits: 0, firstSeen: null, lastSeen: null, playedMs: 0, online: false, longestMs: 0 };
    }

    let first = visits[0]!.joinedAt.getTime();
    let last = 0;
    let played = 0;
    let longest = 0;
    let online = false;

    for (const visit of visits) {
        const from = visit.joinedAt.getTime();
        const to = visit.leftAt?.getTime() ?? now.getTime();
        // A clock that went backwards, or a row half-written by an interrupted
        // sweep. Counted as nothing rather than as negative time.
        const length = Math.max(0, to - from);
        first = Math.min(first, from);
        last = Math.max(last, to);
        played += length;
        longest = Math.max(longest, length);
        if (visit.leftAt === null) online = true;
    }

    return {
        visits: visits.length,
        firstSeen: new Date(first),
        lastSeen: new Date(last),
        playedMs: played,
        online,
        longestMs: longest
    };
}

/** How many were on, at one moment. */
export interface PlayerCount {
    readonly ts: Date;
    /** Null where nothing was recorded, which is a gap rather than an empty server. */
    readonly players: number | null;
}

/**
 * The readings, with the gaps left as gaps.
 *
 * The distinction this exists to keep is between a quiet night and a night nobody
 * was watching. Both are a flat line at zero if the missing readings are treated as
 * zeroes, and a chart that cannot tell those apart is a chart that says something
 * untrue about somebody's server. So a stretch with no readings becomes an explicit
 * null, which a chart draws as a break rather than as a floor.
 */
export function fillGaps(
    readings: readonly { readonly ts: Date; readonly playersOnline: number }[],
    stepMs: number
): PlayerCount[] {
    const sorted = [...readings].sort((left, right) => left.ts.getTime() - right.ts.getTime());
    const series: PlayerCount[] = [];
    let previous: number | null = null;

    for (const reading of sorted) {
        const at = reading.ts.getTime();
        // One missed reading is a sweep that ran late; a run of them is a stretch
        // nobody was looking at, and only the second is worth drawing as absence.
        if (previous !== null && at - previous > stepMs * 2) {
            series.push({ ts: new Date(previous + stepMs), players: null });
        }
        series.push({ ts: reading.ts, players: reading.playersOnline });
        previous = at;
    }
    return series;
}

/**
 * The game's own figures for one player, out of `stats/<uuid>.json`.
 *
 * Minecraft has been keeping these all along, in a file per player beside the world,
 * and they are worth more than anything a panel could count for itself: this is
 * playtime as the server measured it, across every session it has ever had,
 * including the ones from before Polaris was watching.
 *
 * Three spellings, because the file has been through two renames: `play_time` today,
 * `play_one_minute` from 1.13 to 1.16, and a flat `stat.playOneMinute` before the
 * whole file was restructured. All three are ticks, and a tick is 50 ms.
 */
export interface PlayerStats {
    readonly playedMs: number;
    readonly deaths: number;
    readonly mobKills: number;
    readonly playerKills: number;
}

const TICK_MS = 50;

export function readPlayerStats(json: string): PlayerStats | null {
    let root: unknown;
    try {
        root = JSON.parse(json);
    } catch {
        return null;
    }
    if (typeof root !== "object" || root === null) return null;

    const record = root as Record<string, unknown>;
    const stats = (typeof record.stats === "object" && record.stats !== null ? record.stats : record) as Record<
        string,
        unknown
    >;
    const custom = (typeof stats["minecraft:custom"] === "object" && stats["minecraft:custom"] !== null
        ? stats["minecraft:custom"]
        : {}) as Record<string, unknown>;

    const modern = (...names: string[]): number => {
        for (const name of names) {
            const value = custom[`minecraft:${name}`];
            if (typeof value === "number" && Number.isFinite(value)) return value;
        }
        return 0;
    };
    const legacy = (name: string): number => {
        const value = record[`stat.${name}`];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };

    const ticks = modern("play_time", "play_one_minute") || legacy("playOneMinute");
    const deaths = modern("deaths") || legacy("deaths");
    const mobKills = modern("mob_kills") || legacy("mobKills");
    const playerKills = modern("player_kills") || legacy("playerKills");

    // A file that parsed but holds none of this is not this player's statistics -
    // an empty object would otherwise read as somebody who has never died.
    if (ticks === 0 && deaths === 0 && mobKills === 0 && playerKills === 0) return null;
    return { playedMs: ticks * TICK_MS, deaths, mobKills, playerKills };
}

/**
 * What the line under a player's status badge says.
 *
 * The question a row has to answer is "when were they last on", and for ARK there
 * is no other source for it: the game reports who is connected this second and
 * nothing about a minute ago, so what Polaris has watched is the whole of what can
 * be said. The row used to say when it was added to the allow list instead, which
 * is a fact about the list and not about the person - kept here only as the last
 * resort it should always have been, for somebody nobody has ever seen play.
 *
 * Its own function so the three cases can be read at once and tested without a
 * table around them.
 */
export type PresenceLine =
    /** They are on now, and this is when they arrived. */
    | { readonly kind: "since"; readonly iso: string }
    /** They are not on, and this is when they last were. */
    | { readonly kind: "last-on"; readonly iso: string }
    /** Nobody has seen them play. When they were let in is all there is. */
    | { readonly kind: "added"; readonly iso: string }
    | null;

export function presenceLine(input: {
    readonly online: boolean;
    readonly seen: { readonly since: string | null; readonly lastSeen: string | null } | null;
    readonly addedAt: string | null;
}): PresenceLine {
    const { online, seen, addedAt } = input;
    if (online && seen?.since) return { kind: "since", iso: seen.since };
    if (!online) {
        // The end of their last visit, or its start for one that was never closed:
        // a server stopped while somebody was playing leaves a visit open forever,
        // and "last on" is still a better answer than nothing.
        const last = seen?.lastSeen ?? seen?.since ?? null;
        if (last) return { kind: "last-on", iso: last };
    }
    return addedAt ? { kind: "added", iso: addedAt } : null;
}
