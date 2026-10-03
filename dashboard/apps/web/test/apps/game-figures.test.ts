/**
 * Every duration and every count Game servers shows reads through one place:
 * a duration steps up its units, a large count is written short, in the
 * reader's language.
 */

import { describe, expect, it } from "vitest";
import * as figures from "@polaris-app/game-servers/src/lib/figures";
import * as rankings from "@polaris-app/game-servers/src/lib/minecraft/rankings";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Intl writes a narrow or no-break space before "mil" and "M": read as a space. */
const spaced = (text: string) => text.replace(/[  ]/g, " ");

describe("a duration", () => {
    it("steps up its units as it grows", () => {
        expect(figures.formatDuration(45 * SECOND)).toBe("45 s");
        expect(figures.formatDuration(12 * MINUTE)).toBe("12 min");
        expect(figures.formatDuration(90 * MINUTE)).toBe("1.5 h");
        expect(figures.formatDuration(26 * HOUR)).toBe("1.1 d");
        expect(figures.formatDuration(45 * DAY)).toBe("6.4 wk");
        expect(figures.formatDuration(100 * DAY)).toBe("3.3 mo");
        expect(figures.formatDuration(800 * DAY)).toBe("2.2 yr");
    });

    it("keeps one decimal under ten and none past it", () => {
        expect(figures.formatDuration(15 * HOUR)).toBe("15 h");
        expect(figures.formatDuration(9.94 * HOUR)).toBe("9.9 h");
        expect(figures.formatDuration(2 * HOUR)).toBe("2 h");
    });

    it("moves to the next unit rather than reading as a full one of the last", () => {
        expect(figures.formatDuration(59.97 * MINUTE)).toBe("1 h");
        expect(figures.formatDuration(23.99 * HOUR)).toBe("1 d");
        expect(figures.durationParts(7 * DAY)).toEqual({ value: 1, unit: "wk" });
        expect(figures.durationParts(8 * 7 * DAY).unit).toBe("mo");
    });

    it("is written in Spanish with a decimal comma and its own units", () => {
        expect(figures.formatDuration(45 * DAY, "es")).toBe("6,4 sem");
        expect(figures.formatDuration(100 * DAY, "es")).toBe("3,3 mes");
        expect(figures.formatDuration(26 * HOUR, "es")).toBe("1,1 d");
    });

    it("never reads a nonsense value", () => {
        expect(figures.formatDuration(-5)).toBe("0 s");
        expect(figures.formatDuration(Number.NaN)).toBe("0 s");
    });
});

describe("a count", () => {
    it("is written out below ten thousand and short from it", () => {
        expect(figures.formatCount(9_999)).toBe("9999");
        expect(figures.formatCount(10_000)).toBe("10K");
        expect(figures.formatCount(12_345)).toBe("12.3K");
        expect(figures.formatCount(1_234_567)).toBe("1.2M");
    });

    it("is written short the Spanish way in Spanish", () => {
        expect(spaced(figures.formatCount(10_000, "es"))).toBe("10 mil");
        expect(spaced(figures.formatCount(1_234_567, "es"))).toBe("1,2 M");
    });

    it("reads a locale as its language", () => {
        expect(figures.figureLanguage("es-ES")).toBe("es");
        expect(figures.figureLanguage("es")).toBe("es");
        expect(figures.figureLanguage("en-GB")).toBe("en");
        expect(figures.figureLanguage(null)).toBe("en");
    });
});

describe("the side panel's rankings", () => {
    const player = (name: string, playedMs: number, deaths: number) =>
        ({
            name,
            stats: { playedMs, deaths, mobKills: 0, playerKills: 0 },
            tallies: null
        }) as unknown as Parameters<typeof rankings.statsRanking>[1][number];

    it("shows time played stepped up, never thousands of hours", () => {
        const lines = rankings.statsRanking("rank.playtime", [
            player("Steve", 2_000 * HOUR, 1),
            player("Alex", 26 * HOUR, 1)
        ]);
        expect(lines).toEqual(["1. Steve 2.7 mo", "2. Alex 1.1 d"]);
    });

    it("shows a large count short, and in the server's language", () => {
        expect(rankings.statsRanking("rank.deaths", [player("Steve", HOUR, 12_000)])).toEqual([
            "1. Steve 12K"
        ]);
        expect(
            rankings.statsRanking("rank.deaths", [player("Steve", HOUR, 12_000)], "es").map(spaced)
        ).toEqual(["1. Steve 12 mil"]);
    });
});

describe("a score on the side panel", () => {
    it("reads as text beside the number it sorts by (1.20.3 and later)", () => {
        expect(commands.scoreShownAs("Ana", "pe_score", figures.formatDuration(150_000))).toBe(
            'scoreboard players display numberformat Ana pe_score fixed {"text":"2.5 min"}'
        );
        expect(commands.scoreShownAs("Ana", "pe_score", figures.formatDuration(150_000, "es"))).toBe(
            'scoreboard players display numberformat Ana pe_score fixed {"text":"2,5 min"}'
        );
    });
});

