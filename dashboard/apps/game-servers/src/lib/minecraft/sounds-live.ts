/**
 * Who on a running server has the sound pack, in the two shapes a screen can
 * afford: the counts, always, and one bounded page of names when somebody asks.
 *
 * The jar answers with everybody on, which is fine for a server of ten and a
 * wall of tags for a server of thousands. So what leaves the server is the
 * counts plus a page, filtered and ordered here, never the whole list.
 *
 * Pure.
 */

export type LiveSoundState = "loaded" | "pending" | "declined" | "failed";

export interface LiveSoundPlayer {
    readonly name: string;
    readonly state: LiveSoundState;
}

export interface LiveSoundCounts {
    /** Everybody the jar reported. */
    readonly online: number;
    /** Who has the pack loaded. */
    readonly loaded: number;
    /** Who is still being handed it. */
    readonly pending: number;
    /** Who turned it down or could not download it. */
    readonly refused: number;
}

/** Which players a page lists: all, those with the pack, or those without it. */
export type LiveSoundFilter = "all" | "have" | "missing";

/** The most names one page carries. */
export const MAX_LIVE_PAGE = 50;

export function countLiveSounds(players: readonly LiveSoundPlayer[]): LiveSoundCounts {
    let loaded = 0;
    let pending = 0;
    let refused = 0;
    for (const one of players) {
        if (one.state === "loaded") loaded++;
        else if (one.state === "pending") pending++;
        else refused++;
    }
    return { online: players.length, loaded, pending, refused };
}

/**
 * One page of players matching a name search and a filter, by name so the
 * order is the same on every read and only changes when the players do.
 */
export function liveSoundsPage(
    players: readonly LiveSoundPlayer[],
    options: {
        readonly query: string;
        readonly filter: LiveSoundFilter;
        readonly offset: number;
        readonly limit: number;
    }
): { players: LiveSoundPlayer[]; total: number } {
    const query = options.query.trim().toLowerCase();
    const matching = players.filter(
        (one) =>
            (options.filter === "all" ||
                (options.filter === "have") === (one.state === "loaded")) &&
            (!query || one.name.toLowerCase().includes(query))
    );
    matching.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const limit = Math.min(Math.max(options.limit, 1), MAX_LIVE_PAGE);
    const offset = Math.max(options.offset, 0);
    return { players: matching.slice(offset, offset + limit), total: matching.length };
}
