import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import {
    askHost,
    createSeasonIcon,
    PLAIN_ICON_PATH,
    readCalendar,
    SEASON_PATH,
    seasonIconUrl,
    type IconDetails
} from "../src/lib/season-icon";

const A = "https://a.example.com";
const B = "https://b.example.com";
/** Inside winter on the shipped calendar. */
const WINTER_DAY = new Date(2026, 11, 1, 12);
/** In no shipped season. */
const PLAIN_DAY = new Date(2026, 5, 1, 12);

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function png(): Response {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" }
    });
}

/** A calendar that moves halloween to June and keeps the rest shipped. */
const JUNE_HALLOWEEN: core.SeasonCalendar = {
    ...core.DEFAULT_SEASON_CALENDAR,
    halloween: { enabled: true, window: { from: { month: 6, day: 1 }, to: { month: 6, day: 2 } } }
};

type Route = () => Response | Promise<Response>;

function harness(routes: Record<string, Route>, origins: string[], now: Date) {
    const asked: string[] = [];
    const fetch = vi.fn(async (url: string) => {
        asked.push(url);
        const route = routes[url];
        return route ? route() : new Response("not found", { status: 404 });
    });
    const set: IconDetails[] = [];
    const refresh = createSeasonIcon({
        origins: async () => origins,
        fetch,
        now: () => now,
        rasterize: async () => ({ 16: "img16" as unknown as ImageData }),
        setIcon: async (details) => void set.push(details)
    });
    return { refresh, set, asked };
}

describe("readCalendar", () => {
    it("reads a calendar, null when seasons are off, undefined for anything else", () => {
        expect(readCalendar({ calendar: core.DEFAULT_SEASON_CALENDAR })).toEqual(
            core.DEFAULT_SEASON_CALENDAR
        );
        expect(readCalendar({ calendar: JUNE_HALLOWEEN })).toEqual(JUNE_HALLOWEEN);
        expect(readCalendar({ calendar: null })).toBeNull();
        expect(readCalendar(null)).toBeUndefined();
        expect(readCalendar({ product: "polaris" })).toBeUndefined();
        expect(readCalendar({ calendar: "winter" })).toBeUndefined();
    });

    it("takes a malformed season as its shipped dates, not on trust", () => {
        const read = readCalendar({
            calendar: {
                ...core.DEFAULT_SEASON_CALENDAR,
                winter: { enabled: "yes", window: { from: { month: 2, day: 31 }, to: 4 } }
            }
        });
        expect(read?.winter).toEqual(core.DEFAULT_SEASON_CALENDAR.winter);
    });
});

describe("askHost", () => {
    it("leaves out a host that predates the route, and says it was reached", async () => {
        const fetch = async () => new Response("<!doctype html>", { status: 404 });
        expect(await askHost(A, fetch)).toEqual({ host: A, calendar: undefined, reached: true });
    });

    it("says when a host could not be reached", async () => {
        const fetch = async () => {
            throw new TypeError("Failed to fetch");
        };
        expect(await askHost(A, fetch)).toEqual({ host: A, calendar: undefined, reached: false });
    });

    it("asks with no credentials and no referrer", async () => {
        const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ calendar: null }));
        await askHost(A, fetch);
        expect(fetch.mock.calls[0]?.[0]).toBe(`${A}${SEASON_PATH}`);
        expect(fetch.mock.calls[0]?.[1]).toMatchObject({
            credentials: "omit",
            referrerPolicy: "no-referrer"
        });
    });
});

describe("the toolbar icon", () => {
    it("wears the official season, drawn from the first host taking part", async () => {
        const { refresh, set, asked } = harness(
            {
                [`${A}${SEASON_PATH}`]: () => json({ calendar: core.DEFAULT_SEASON_CALENDAR }),
                [`${B}${SEASON_PATH}`]: () => json({ calendar: core.DEFAULT_SEASON_CALENDAR }),
                [seasonIconUrl(A, "winter")]: png
            },
            [B, A],
            WINTER_DAY
        );
        expect(await refresh()).toEqual({ kind: "dressed", season: "winter" });
        expect(set).toEqual([{ imageData: { 16: "img16" } }]);
        expect(asked).toContain(seasonIconUrl(A, "winter"));
        expect(asked).not.toContain(seasonIconUrl(B, "winter"));
    });

    it("lets a host's own dates apply only outside every official season", async () => {
        const { refresh } = harness(
            {
                [`${B}${SEASON_PATH}`]: () => json({ calendar: JUNE_HALLOWEEN }),
                [seasonIconUrl(B, "halloween")]: png
            },
            [A, B],
            PLAIN_DAY
        );
        expect(await refresh()).toEqual({ kind: "dressed", season: "halloween" });
    });

    it("stays plain when every host is too old to say, or turned seasons off", async () => {
        const { refresh, set } = harness(
            { [`${B}${SEASON_PATH}`]: () => json({ calendar: null }) },
            [A, B],
            WINTER_DAY
        );
        expect(await refresh()).toEqual({ kind: "plain" });
        expect(set).toEqual([{ path: { 16: PLAIN_ICON_PATH, 32: PLAIN_ICON_PATH, 48: PLAIN_ICON_PATH, 128: PLAIN_ICON_PATH } }]);
    });

    it("reverts once the season ends", async () => {
        const routes = { [`${A}${SEASON_PATH}`]: () => json({ calendar: core.DEFAULT_SEASON_CALENDAR }), [seasonIconUrl(A, "winter")]: png };
        let now = WINTER_DAY;
        const set: IconDetails[] = [];
        const refresh = createSeasonIcon({
            origins: async () => [A],
            fetch: async (url: string) => (routes[url] ?? (() => new Response(null, { status: 404 })))(),
            now: () => now,
            rasterize: async () => ({}),
            setIcon: async (details) => void set.push(details)
        });
        expect((await refresh()).kind).toBe("dressed");
        now = PLAIN_DAY;
        expect(await refresh()).toEqual({ kind: "plain" });
        expect(set.at(-1)).toHaveProperty("path");
    });

    it("falls back to the next host, then plain, when the mark cannot be had", async () => {
        const calendar = () => json({ calendar: core.DEFAULT_SEASON_CALENDAR });
        const next = harness(
            { [`${A}${SEASON_PATH}`]: calendar, [`${B}${SEASON_PATH}`]: calendar, [seasonIconUrl(B, "winter")]: png },
            [A, B],
            WINTER_DAY
        );
        expect(await next.refresh()).toEqual({ kind: "dressed", season: "winter" });
        const none = harness({ [`${A}${SEASON_PATH}`]: calendar, [seasonIconUrl(A, "winter")]: () => json({}) }, [A], WINTER_DAY);
        expect(await none.refresh()).toEqual({ kind: "plain" });
    });

    it("leaves the icon alone when no host can be reached", async () => {
        const set: IconDetails[] = [];
        const refresh = createSeasonIcon({
            origins: async () => [A, B],
            fetch: async () => {
                throw new TypeError("Failed to fetch");
            },
            now: () => WINTER_DAY,
            rasterize: async () => ({}),
            setIcon: async (details) => void set.push(details)
        });
        expect(await refresh()).toEqual({ kind: "kept" });
        expect(set).toEqual([]);
    });

    it("is plain with no servers at all", async () => {
        const { refresh } = harness({}, [], WINTER_DAY);
        expect(await refresh()).toEqual({ kind: "plain" });
    });

    it("applies only the latest of two overlapping refreshes", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let origins = [A];
        const set: IconDetails[] = [];
        const refresh = createSeasonIcon({
            origins: async () => origins,
            fetch: async (url: string) => {
                if (url.startsWith(A)) await gate;
                return url.endsWith(SEASON_PATH) ? json({ calendar: null }) : png();
            },
            now: () => WINTER_DAY,
            rasterize: async () => ({}),
            setIcon: async (details) => void set.push(details)
        });
        const first = refresh();
        origins = [B];
        const second = await refresh();
        release();
        expect(second).toEqual({ kind: "plain" });
        expect(await first).toEqual({ kind: "kept" });
        expect(set).toHaveLength(1);
    });
});
