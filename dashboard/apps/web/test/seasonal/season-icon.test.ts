import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import { GET } from "@/app/season-icon/[file]/route";
import { appIconReport } from "@/lib/app-icon-report";
import { parseSeasonIconFile, seasonIconPng, seasonIconSvg } from "@/lib/season-icon";

function fetchIcon(file: string) {
    return GET(new Request(`https://polaris.example.test/season-icon/${file}`), {
        params: Promise.resolve({ file })
    });
}

describe("season icon addresses", () => {
    it("names the season, so a cached icon from another season is never reused", () => {
        expect(seasonIconSvg("winter")).toBe("/season-icon/winter.svg");
        expect(seasonIconSvg(null)).toBe("/icon.svg");
        expect(seasonIconPng("halloween", 180)).toBe("/season-icon/halloween-180.png");
        expect(seasonIconPng(null, 180)).toBe("/apple-touch-icon.png");
        expect(seasonIconPng(null, 512)).toBe("/polaris-mark-512.png");
    });

    it("reads back only the files it names", () => {
        expect(parseSeasonIconFile("winter.svg")).toEqual({ season: "winter", size: null });
        expect(parseSeasonIconFile("newYear-192.png")).toEqual({ season: "newYear", size: 192 });
        for (const bad of ["winter-192.svg", "winter.png", "winter-64.png", "spring.svg", "../x.svg", ""])
            expect(parseSeasonIconFile(bad)).toBeNull();
    });
});

describe("season icon route", () => {
    it("serves the dressed mark as a vector", async () => {
        const response = await fetchIcon("winter.svg");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        expect(await response.text()).toBe(core.seasonMarkSvg("winter"));
    });

    it("serves a PNG of the asked size", async () => {
        const response = await fetchIcon("winter-192.png");
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([192, 192]);
    }, 30_000);

    it("answers 404 for anything else", async () => {
        expect((await fetchIcon("spring.svg")).status).toBe(404);
    });
});

describe("appIconReport", () => {
    const WINTER = new Date(2026, 10, 22, 12);

    it("reports the official season, flagged, with its mark to draw", () => {
        const report = appIconReport(core.DEFAULT_SEASON_CALENDAR, WINTER);
        expect(report).toMatchObject({ season: "winter", official: true, seasons: ["winter"] });
    });

    it("asks for nothing when this host's seasons are off", () => {
        expect(appIconReport(null, WINTER)).toEqual({ season: null, official: false, calendar: null, seasons: [] });
    });

    it("offers this host's own season beside the official one", () => {
        const custom: core.SeasonCalendar = {
            ...core.DEFAULT_SEASON_CALENDAR,
            winter: { enabled: false, window: core.DEFAULT_SEASON_CALENDAR.winter.window },
            halloween: { enabled: true, window: { from: { month: 11, day: 3 }, to: { month: 11, day: 30 } } }
        };
        const report = appIconReport(custom, WINTER);
        expect(report.season).toBe("winter");
        expect([...report.seasons].sort()).toEqual(["halloween", "winter"]);
    });
});
