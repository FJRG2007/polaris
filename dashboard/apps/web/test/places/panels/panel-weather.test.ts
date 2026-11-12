/**
 * The weather a wall asks for: read from the place's own location, asked of
 * the forecast service once per coordinate while it is fresh, and nothing
 * asked for a place with no location.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const follow = vi.fn();
const readCapped = vi.fn();
let panelRow: unknown = null;

vi.mock("@polaris/app-host", () => ({ host: { safeFetch: { follow, readCapped } } }));
vi.mock("@polaris/db", () => ({
    prisma: { placePanel: { findFirst: async () => panelRow } }
}));

const { panelWeather, weatherAt, forgetWeather } = await import(
    "@polaris-app/places/src/lib/panel-weather"
);

const FORECAST = {
    current: { temperature_2m: 18.2, weather_code: 61 },
    daily: { temperature_2m_max: [20], temperature_2m_min: [11] }
};

beforeEach(() => {
    forgetWeather();
    follow.mockReset();
    readCapped.mockReset();
    follow.mockResolvedValue(new Response("{}"));
    readCapped.mockResolvedValue(new TextEncoder().encode(JSON.stringify(FORECAST)));
});

describe("panel weather", () => {
    it("asks once per coordinate while the answer is fresh", async () => {
        const now = Date.now();
        const first = await weatherAt(40.42, -3.7, now);
        const again = await weatherAt(40.42, -3.7, now + 60_000);
        expect(first).toEqual({ temperature: 18.2, code: 61, high: 20, low: 11 });
        expect(again).toEqual(first);
        expect(follow).toHaveBeenCalledTimes(1);
        await weatherAt(40.42, -3.7, now + 11 * 60_000);
        expect(follow).toHaveBeenCalledTimes(2);
    });

    it("answers null when the service cannot be reached", async () => {
        follow.mockResolvedValue(null);
        expect(await weatherAt(1, 2)).toBeNull();
    });

    it("says a place with no location is not located, and asks nothing", async () => {
        panelRow = { place: { latitude: null, longitude: null } };
        expect(await panelWeather("i1", "p1")).toEqual({ located: false, weather: null });
        expect(follow).not.toHaveBeenCalled();
    });

    it("reads the place's location, and nothing for another install's panel", async () => {
        panelRow = { place: { latitude: 51.5, longitude: -0.12 } };
        expect(await panelWeather("i1", "p1")).toMatchObject({ located: true });
        panelRow = null;
        expect(await panelWeather("i2", "p1")).toBeNull();
    });
});
