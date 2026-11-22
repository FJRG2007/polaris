import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

/** A calendar with one season's window moved, the rest as shipped. */
function moved(season: core.Season, from: [number, number], to: [number, number]): core.SeasonCalendar {
    return {
        ...core.DEFAULT_SEASON_CALENDAR,
        [season]: {
            enabled: true,
            window: { from: { month: from[0], day: from[1] }, to: { month: to[0], day: to[1] } }
        }
    };
}

/** Between the shipped Halloween and the shipped winter: no official season. */
const GAP = new Date(2026, 10, 10, 12);
/** Inside the shipped winter. */
const WINTER = new Date(2026, 10, 22, 12);

describe("appIconSeason", () => {
    it("is plain with no host at all", () => {
        expect(core.appIconSeason([], WINTER)).toBeNull();
    });

    it("is plain when no host takes part: seasons off, or too old to say", () => {
        expect(
            core.appIconSeason(
                [
                    { host: "https://a.example.test", calendar: null },
                    { host: "https://b.example.test", calendar: undefined }
                ],
                WINTER
            )
        ).toBeNull();
    });

    it("wears the official season over a host's custom one", () => {
        // Winter starts later on this host, and Halloween runs on into its place.
        const custom = { ...moved("halloween", [11, 3], [11, 30]), winter: moved("winter", [12, 1], [1, 9]).winter };
        expect(core.seasonOn(WINTER, custom)).toBe("halloween");
        const reports = [
            { host: "https://a.example.test", calendar: custom },
            { host: "https://b.example.test", calendar: core.DEFAULT_SEASON_CALENDAR }
        ];
        expect(core.appIconSeason(reports, WINTER)).toBe("winter");
        // Even when the only host taking part is the custom one.
        expect(core.appIconSeason([reports[0]!], WINTER)).toBe("winter");
    });

    it("ignores a host that switched the official season off", () => {
        const off = { ...core.DEFAULT_SEASON_CALENDAR, winter: { ...core.DEFAULT_SEASON_CALENDAR.winter, enabled: false } };
        expect(core.appIconSeason([{ host: "https://a.example.test", calendar: off }], WINTER)).toBe("winter");
    });

    it("picks between two hosts' custom seasons by host, whatever order they report in", () => {
        const a = { host: "https://a.example.test", calendar: moved("halloween", [11, 3], [11, 14]) };
        const b = { host: "https://b.example.test", calendar: moved("winter", [11, 5], [1, 9]) };
        expect(core.officialSeasonOn(GAP)).toBeNull();
        expect(core.appIconSeason([a, b], GAP)).toBe("halloween");
        expect(core.appIconSeason([b, a], GAP)).toBe("halloween");
    });

    it("falls through to the next host when the first has no season today", () => {
        const a = { host: "https://a.example.test", calendar: core.DEFAULT_SEASON_CALENDAR };
        const b = { host: "https://b.example.test", calendar: moved("winter", [11, 5], [1, 9]) };
        expect(core.appIconSeason([a, b], GAP)).toBe("winter");
    });

    it("lets an old host neither win nor block", () => {
        const b = { host: "https://b.example.test", calendar: moved("winter", [11, 5], [1, 9]) };
        expect(core.appIconSeason([{ host: "https://a.example.test", calendar: undefined }, b], GAP)).toBe("winter");
        expect(core.appIconSeason([{ host: "https://a.example.test", calendar: undefined }], GAP)).toBeNull();
    });

    it("is plain on a day no calendar has a season", () => {
        const day = new Date(2026, 6, 1, 12);
        expect(core.appIconSeason([{ host: "https://a.example.test", calendar: core.DEFAULT_SEASON_CALENDAR }], day)).toBeNull();
    });
});
