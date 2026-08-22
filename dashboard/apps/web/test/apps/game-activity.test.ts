/**
 * Turning two rosters into a history.
 *
 * The rule is deliberately not a log parser: it compares who is on now against who
 * was on a minute ago, which is the only approach that works for both games - ARK
 * prints nothing worth parsing. So the cases that matter are the ones where the two
 * rosters disagree in a way that is not simply somebody arriving: a name that comes
 * back cased differently, a sweep that was interrupted halfway, a server nobody
 * asked for an hour.
 */

import { describe, expect, it } from "vitest";
import {
    fillGaps,
    historyOf,
    presenceLine,
    readPlayerStats,
    rosterChange,
    seenFor,
    seenKey
} from "@/lib/apps/games-activity";

const NOW = new Date("2026-08-13T21:00:00.000Z");

function open(entries: [string, string][], playerId: string | null = null) {
    return entries.map(([id, name]) => ({ id, name, playerId }));
}

/** A roster as Minecraft answers it: names, and no second id. */
function named(...names: string[]) {
    return names.map((name) => ({ name, id: null }));
}

/** And as ARK answers it: a survivor name with the Steam id beside it. */
function survivor(name: string, id: string) {
    return { name, id };
}

describe("what changed since the last look", () => {
    it("sees an arrival and a departure in one pass", () => {
        const change = rosterChange(open([["s1", "Alice"]]), named("Alice", "Bob"));
        expect(change.arrived).toEqual([{ name: "Bob", id: null }]);
        expect(change.left).toEqual([]);

        const after = rosterChange(open([["s1", "Alice"], ["s2", "Bob"]]), named("Bob"));
        expect(after.arrived).toEqual([]);
        expect(after.left).toEqual(["s1"]);
    });

    it("does not read a change of capitals as leaving and coming back", () => {
        // Only the server decides how it spells a name, and it does not always
        // give the same answer twice. Taken literally, that is a player who
        // disconnects and reconnects every minute, forever.
        expect(rosterChange(open([["s1", "Alice"]]), named("alice"))).toEqual({
            arrived: [],
            left: [],
            adopted: []
        });
    });

    it("keeps the newest spelling for somebody arriving", () => {
        expect(rosterChange([], named("  Alice  ")).arrived).toEqual([{ name: "Alice", id: null }]);
    });

    it("heals a duplicate left behind by an interrupted sweep", () => {
        // Two open sessions for one player means a pass died between writing and
        // committing. One is the visit; the rest are closed rather than kept.
        const change = rosterChange(open([["s1", "Alice"], ["s2", "Alice"]]), named("Alice"));
        expect(change.arrived).toEqual([]);
        expect(change.left).toEqual(["s2"]);
    });

    it("closes everything when the server empties", () => {
        expect(rosterChange(open([["s1", "Alice"], ["s2", "Bob"]]), []).left).toEqual(["s1", "s2"]);
    });

    it("ignores a blank name rather than opening a session for nobody", () => {
        expect(rosterChange([], named("", "   ")).arrived).toEqual([]);
    });

    it("keeps one visit for a survivor renamed mid-session", () => {
        // ARK lets somebody rename their survivor whenever they like, and the
        // roster prints the new name from the next second on. Matched by name that
        // is one player leaving and a stranger arriving, every time.
        const change = rosterChange(open([["s1", "Rex"]], "765"), [survivor("Rexy", "765")]);
        expect(change).toEqual({ arrived: [], left: [], adopted: [] });
    });

    it("tells two survivors who picked the same name apart", () => {
        // The name is decoration on ARK: two people can both call themselves
        // Survivor, and the one who left has to be the one whose visit closes.
        const change = rosterChange(open([["s1", "Survivor"]], "111"), [survivor("Survivor", "222")]);
        expect(change.left).toEqual(["s1"]);
        expect(change.arrived).toEqual([survivor("Survivor", "222")]);
    });

    it("still matches a visit recorded before the id was kept, and writes the id on it", () => {
        // Every row already written has no id. Matched by name, as it always was,
        // rather than read as everybody on the server leaving at once - and told
        // whose it is now that the game has said, so the visit somebody is on
        // right now is not lost to their row the moment it ends.
        const change = rosterChange(open([["s1", "Rex"]]), [survivor("Rex", "765")]);
        expect(change).toEqual({ arrived: [], left: [], adopted: [{ id: "s1", playerId: "765" }] });
    });

    it("adopts nothing on a game that reports no id of its own", () => {
        expect(rosterChange(open([["s1", "Alice"]]), named("Alice")).adopted).toEqual([]);
    });
});

describe("what somebody's visits add up to", () => {
    const at = (iso: string) => new Date(iso);

    it("counts the visit in progress up to now", () => {
        // A total that only moves when somebody leaves reads as broken to whoever
        // is watching it move.
        const history = historyOf([{ joinedAt: at("2026-08-13T20:00:00.000Z"), leftAt: null }], NOW);
        expect(history.playedMs).toBe(60 * 60 * 1000);
        expect(history.online).toBe(true);
        expect(history.lastSeen).toEqual(NOW);
    });

    it("adds up every visit and remembers the first", () => {
        const history = historyOf(
            [
                { joinedAt: at("2026-08-01T10:00:00.000Z"), leftAt: at("2026-08-01T12:00:00.000Z") },
                { joinedAt: at("2026-08-13T19:00:00.000Z"), leftAt: at("2026-08-13T19:30:00.000Z") }
            ],
            NOW
        );
        expect(history.visits).toBe(2);
        expect(history.firstSeen).toEqual(at("2026-08-01T10:00:00.000Z"));
        expect(history.lastSeen).toEqual(at("2026-08-13T19:30:00.000Z"));
        expect(history.playedMs).toBe(2.5 * 60 * 60 * 1000);
        expect(history.longestMs).toBe(2 * 60 * 60 * 1000);
        expect(history.online).toBe(false);
    });

    it("counts a backwards clock as no time rather than negative time", () => {
        const history = historyOf(
            [{ joinedAt: at("2026-08-13T20:00:00.000Z"), leftAt: at("2026-08-13T19:00:00.000Z") }],
            NOW
        );
        expect(history.playedMs).toBe(0);
    });

    it("says nothing about somebody who has never been", () => {
        expect(historyOf([], NOW)).toEqual({
            visits: 0,
            firstSeen: null,
            lastSeen: null,
            playedMs: 0,
            online: false,
            longestMs: 0
        });
    });
});

describe("the readings behind the chart", () => {
    const step = 60_000;
    const reading = (minute: number, playersOnline: number) => ({
        ts: new Date(Date.UTC(2026, 7, 13, 20, minute)),
        playersOnline
    });

    it("leaves a stretch nobody watched as a break, not as an empty server", () => {
        // This is the whole reason the readings are kept at all. Filled with
        // zeroes, an hour with no sweep and an hour with nobody playing draw the
        // same line, and one of those is a lie about somebody's server.
        const series = fillGaps([reading(0, 4), reading(30, 5)], step);
        expect(series.map((point) => point.players)).toEqual([4, null, 5]);
    });

    it("does not break the line for a sweep that merely ran late", () => {
        expect(fillGaps([reading(0, 4), reading(2, 4)], step).map((point) => point.players)).toEqual([4, 4]);
    });

    it("puts the readings in order before reading them", () => {
        const series = fillGaps([reading(2, 9), reading(0, 4), reading(1, 6)], step);
        expect(series.map((point) => point.players)).toEqual([4, 6, 9]);
    });
});

describe("the game's own figures for a player", () => {
    it("reads the file today's servers write", () => {
        const stats = readPlayerStats(
            JSON.stringify({
                stats: {
                    "minecraft:custom": {
                        "minecraft:play_time": 72000,
                        "minecraft:deaths": 3,
                        "minecraft:mob_kills": 41,
                        "minecraft:player_kills": 2
                    }
                },
                DataVersion: 4189
            })
        );
        // 72000 ticks at 50 ms is an hour.
        expect(stats?.playedMs).toBe(60 * 60 * 1000);
        expect(stats?.deaths).toBe(3);
        expect(stats?.mobKills).toBe(41);
    });

    it("reads the name playtime had between 1.13 and 1.16", () => {
        const stats = readPlayerStats(
            JSON.stringify({ stats: { "minecraft:custom": { "minecraft:play_one_minute": 1200 } } })
        );
        expect(stats?.playedMs).toBe(60_000);
    });

    it("reads the flat file from before 1.13", () => {
        // Lucky blocks is a 1.13 map and skyblock a 1.16 one, so a server here can
        // genuinely be old enough to have written either of the older shapes.
        const stats = readPlayerStats(JSON.stringify({ "stat.playOneMinute": 1200, "stat.deaths": 7 }));
        expect(stats?.playedMs).toBe(60_000);
        expect(stats?.deaths).toBe(7);
    });

    it("says nothing rather than inventing a player with no deaths", () => {
        expect(readPlayerStats("{}")).toBeNull();
        expect(readPlayerStats('{"stats":{"minecraft:custom":{}}}')).toBeNull();
    });

    it("survives a file that is not what it says it is", () => {
        expect(readPlayerStats("not json at all")).toBeNull();
        expect(readPlayerStats("null")).toBeNull();
        expect(readPlayerStats('{"stats":{"minecraft:custom":{"minecraft:play_time":"lots"}}}')).toBeNull();
    });
});

/**
 * The line under a player's status badge.
 *
 * It used to say when the row was added to the allow list, which is a fact about
 * the list: an operator looking at a name wants to know when that person was last
 * on, and on an ARK server nothing but Polaris's own record can say.
 */
describe("presenceLine", () => {
    const seen = { since: "2026-08-13T19:00:00.000Z", lastSeen: "2026-08-13T20:00:00.000Z" };
    const added = "2026-08-01T09:00:00.000Z";

    it("says when somebody playing arrived, not when they were added", () => {
        expect(presenceLine({ online: true, seen, addedAt: added })).toEqual({
            kind: "since",
            iso: seen.since
        });
    });

    it("says when somebody offline was last on", () => {
        expect(presenceLine({ online: false, seen, addedAt: added })).toEqual({
            kind: "last-on",
            iso: seen.lastSeen
        });
    });

    it("falls back to when a visit started for one that was never closed", () => {
        // A server stopped while somebody was playing leaves their visit open, and
        // "last on when they arrived" beats saying nothing.
        expect(
            presenceLine({ online: false, seen: { since: seen.since, lastSeen: null }, addedAt: added })
        ).toEqual({ kind: "last-on", iso: seen.since });
    });

    it("only says when they were added for somebody nobody has seen play", () => {
        expect(presenceLine({ online: false, seen: null, addedAt: added })).toEqual({
            kind: "added",
            iso: added
        });
        // Somebody reported as playing before the first sweep has watched them:
        // there is nothing truthful to say about a visit yet.
        expect(presenceLine({ online: true, seen: null, addedAt: added })).toEqual({
            kind: "added",
            iso: added
        });
    });

    it("says nothing at all when there is nothing to say", () => {
        expect(presenceLine({ online: false, seen: null, addedAt: null })).toBeNull();
    });
});

/**
 * Finding a row's own history.
 *
 * The row and the visit need not be drawn under the same name: an ARK row for
 * somebody offline carries the label whoever added them typed, and the visit was
 * recorded under whatever the server called their survivor.
 */
describe("seenFor", () => {
    const visit = { since: "2026-08-13T19:00:00.000Z", lastSeen: "2026-08-13T20:00:00.000Z" };

    it("finds the visit by id when the row and the visit disagree on the name", () => {
        const seen = { [seenKey({ name: "Rex", id: "765" })]: visit };
        expect(seenFor(seen, { id: "765", names: ["Er Migue"] })).toEqual(visit);
    });

    it("falls back to the name for a game with no id, and for the older rows", () => {
        const seen = { [seenKey({ name: "Alice", id: null })]: visit };
        expect(seenFor(seen, { id: null, names: ["alice"] })).toEqual(visit);
        expect(seenFor(seen, { id: "765", names: ["Alice"] })).toEqual(visit);
    });

    it("does not hand somebody a stranger's history", () => {
        const seen = { [seenKey({ name: "Rex", id: "765" })]: visit };
        expect(seenFor(seen, { id: "111", names: ["Survivor", ""] })).toBeNull();
    });
});
