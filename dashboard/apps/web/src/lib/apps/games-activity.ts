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

/** A visit that has not ended: who, since when, and the row it belongs to. */
export interface OpenSession {
    readonly id: string;
    readonly name: string;
}

/** What changed between the roster last seen and the roster now. */
export interface RosterChange {
    /** Names to start a session for. */
    readonly arrived: readonly string[];
    /** Sessions to close, by id. */
    readonly left: readonly string[];
}

/**
 * Fold a fresh roster against the sessions still open into arrivals and departures.
 *
 * Names are matched without case, because how a name is capitalised is the server's
 * business and not always the same answer twice - a roster that comes back
 * differently cased would otherwise read as everybody leaving and immediately
 * rejoining. The name as it arrives is what gets stored, so the newest spelling is
 * the one shown.
 *
 * Duplicates on either side are tolerated rather than trusted: two open sessions for
 * one name means an earlier sweep was interrupted, and closing all but one is how
 * that heals rather than something to refuse.
 */
export function rosterChange(open: readonly OpenSession[], roster: readonly string[]): RosterChange {
    const here = new Map<string, string>();
    for (const name of roster) {
        const key = name.trim().toLowerCase();
        if (key.length > 0 && !here.has(key)) here.set(key, name.trim());
    }

    const kept = new Set<string>();
    const left: string[] = [];
    for (const session of open) {
        const key = session.name.trim().toLowerCase();
        // Still on, and this is the first session claiming so. A second one is a
        // duplicate from an interrupted sweep and is closed.
        if (here.has(key) && !kept.has(key)) kept.add(key);
        else left.push(session.id);
    }

    return { arrived: [...here.entries()].filter(([key]) => !kept.has(key)).map(([, name]) => name), left };
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
