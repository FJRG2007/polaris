/**
 * The vocabulary of an activity, on its own: what a game is recognized by, what
 * the settings accept, and how time is counted on a card.
 *
 * What is pinned: a program is known by its bare lowercased name whatever path
 * it arrived with, so the hide list matches what the desktop app sees next time;
 * a report or a setting that is not a program name is refused rather than
 * stored; a stored list with one bad entry loses that entry and keeps the rest,
 * because a hide list that came back empty would publish every game on it; and
 * the master switch overrides every source.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

describe("what a game is known by", () => {
    it("is the program's own name, lowercased, without its folder", () => {
        expect(core.gameKeyOf("C:\\Games\\Hollow Knight\\hollow_knight.exe")).toBe(
            "hollow_knight.exe"
        );
        expect(core.gameKeyOf("/Applications/Celeste.app/Contents/MacOS/Celeste")).toBe("celeste");
        expect(core.gameKeyOf("  Factorio  ")).toBe("factorio");
    });

    it("refuses a name with a path or a control character left in it", () => {
        expect(core.gameKeySchema.safeParse("").success).toBe(false);
        expect(core.gameKeySchema.safeParse("game\u0000.exe").success).toBe(false);
        expect(core.gameKeySchema.safeParse("x".repeat(121)).success).toBe(false);
    });
});

describe("a report from the desktop app", () => {
    it("takes a game, or nothing", () => {
        const game = core.gameReportSchema.parse({
            game: { key: "C:\\x\\Game.EXE", name: " Game ", startedAt: "2026-09-01T10:00:00.000Z" }
        });
        expect(game.game).toEqual({
            key: "game.exe",
            name: "Game",
            startedAt: "2026-09-01T10:00:00.000Z"
        });
        expect(core.gameReportSchema.parse({ game: null }).game).toBeNull();
    });

    it("refuses a start that is not a moment", () => {
        expect(
            core.gameReportSchema.safeParse({
                game: { key: "a", name: "A", startedAt: "yesterday" }
            }).success
        ).toBe(false);
    });
});

describe("the settings", () => {
    it("start with everything shared", () => {
        expect(core.DEFAULT_ACTIVITY_SETTINGS).toMatchObject({
            share: true,
            spotify: true,
            games: true,
            minecraft: true,
            hiddenGames: [],
            customGames: []
        });
    });

    it("let the master switch override every source", () => {
        const off = { ...core.DEFAULT_ACTIVITY_SETTINGS, share: false };
        for (const source of core.ACTIVITY_SOURCES)
            expect(core.activitySourceOn(off, source)).toBe(false);
        const noGames = { ...core.DEFAULT_ACTIVITY_SETTINGS, games: false };
        expect(core.activitySourceOn(noGames, "game")).toBe(false);
        expect(core.activitySourceOn(noGames, "spotify")).toBe(true);
    });

    it("refuse the same program added twice", () => {
        const twice = core.activitySettingsSchema.safeParse({
            customGames: [
                { executable: "a.exe", name: "A" },
                { executable: "A.EXE", name: "Also A" }
            ]
        });
        expect(twice.success).toBe(false);
    });

    it("read a stored list entry by entry", () => {
        const kept = core.readStoredList('["ok.exe", "", 7, "fine"]', core.gameKeySchema);
        expect(kept).toEqual(["ok.exe", "fine"]);
        expect(core.readStoredList("not json", core.gameKeySchema)).toEqual([]);
        expect(core.readStoredList('{"a":1}', core.gameKeySchema)).toEqual([]);
    });
});

describe("time on a card", () => {
    it("reads like a clock", () => {
        expect(core.formatElapsed(0)).toBe("0:00");
        expect(core.formatElapsed(187_000)).toBe("3:07");
        expect(core.formatElapsed(3_729_000)).toBe("1:02:09");
        expect(core.formatElapsed(-3_000)).toBe("0:00");
    });

    it("holds a track's position inside its length", () => {
        const track = { startedAt: "2026-09-01T10:00:00.000Z", endsAt: "2026-09-01T10:03:00.000Z" };
        const start = Date.parse(track.startedAt);
        expect(core.trackProgress(track, start + 60_000)).toEqual({
            elapsedMs: 60_000,
            totalMs: 180_000
        });
        expect(core.trackProgress(track, start + 999_000)?.elapsedMs).toBe(180_000);
        expect(core.trackProgress(track, start - 5_000)?.elapsedMs).toBe(0);
        expect(core.trackProgress({ startedAt: track.startedAt, endsAt: null }, start)).toBeNull();
    });

    it("words a card the way people say it", () => {
        expect(core.activityShortLine({ source: "game", name: "Celeste" })).toBe("Playing Celeste");
        expect(core.activityShortLine({ source: "spotify", name: "Song" })).toBe(
            "Listening to Song"
        );
    });
});

describe("who may see it", () => {
    it("is a privacy field, open by default, beside last seen", () => {
        expect(core.DEFAULT_PRIVACY.activity.audience).toBe("everyone");
        const presence = core.PRIVACY_SECTIONS.find((section) => section.id === "presence");
        expect(presence?.fields).toContain("activity");
    });
});
