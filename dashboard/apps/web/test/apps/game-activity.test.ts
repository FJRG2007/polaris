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
import { fillGaps, historyOf, readPlayerStats, rosterChange } from "@/lib/apps/games-activity";

const NOW = new Date("2026-08-13T21:00:00.000Z");

function open(entries: [string, string][]) {
    return entries.map(([id, name]) => ({ id, name }));
}

describe("what changed since the last look", () => {
    it("sees an arrival and a departure in one pass", () => {
        const change = rosterChange(open([["s1", "Alice"]]), ["Alice", "Bob"]);
        expect(change.arrived).toEqual(["Bob"]);
        expect(change.left).toEqual([]);

        const after = rosterChange(open([["s1", "Alice"], ["s2", "Bob"]]), ["Bob"]);
        expect(after.arrived).toEqual([]);
        expect(after.left).toEqual(["s1"]);
    });

    it("does not read a change of capitals as leaving and coming back", () => {
        // Only the server decides how it spells a name, and it does not always
        // give the same answer twice. Taken literally, that is a player who
        // disconnects and reconnects every minute, forever.
        expect(rosterChange(open([["s1", "Alice"]]), ["alice"])).toEqual({ arrived: [], left: [] });
    });

    it("keeps the newest spelling for somebody arriving", () => {
        expect(rosterChange([], ["  Alice  "]).arrived).toEqual(["Alice"]);
    });

    it("heals a duplicate left behind by an interrupted sweep", () => {
        // Two open sessions for one player means a pass died between writing and
        // committing. One is the visit; the rest are closed rather than kept.
        const change = rosterChange(open([["s1", "Alice"], ["s2", "Alice"]]), ["Alice"]);
        expect(change.arrived).toEqual([]);
        expect(change.left).toEqual(["s2"]);
    });

    it("closes everything when the server empties", () => {
        expect(rosterChange(open([["s1", "Alice"], ["s2", "Bob"]]), []).left).toEqual(["s1", "s2"]);
    });

    it("ignores a blank name rather than opening a session for nobody", () => {
        expect(rosterChange([], ["", "   "]).arrived).toEqual([]);
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
