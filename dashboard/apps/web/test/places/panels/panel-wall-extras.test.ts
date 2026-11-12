/**
 * The wall's additions: the weather card and its forecast, a panel's look,
 * the screensaver's drift, and the device list's search, grouping and window.
 */

import { describe, expect, it } from "vitest";
import {
    DEFAULT_PANEL_STYLE,
    addCard,
    panelCardsSchema,
    panelStyleSchema,
    storedStyle
} from "@polaris-app/places/src/lib/panel-layout";
import {
    forecastUrl,
    parseForecast,
    parseWeatherAnswer,
    weatherGroup
} from "@polaris-app/places/src/lib/weather-kinds";
import {
    driftPosition,
    wallSurface,
    wallTheme
} from "@polaris-app/places/src/screens/panels/panel-state";
import { foldText, listRows, visibleRange } from "@polaris-app/places/src/lib/panel-list";

describe("weather card", () => {
    it("is a card the schema accepts and addCard places", () => {
        const cards = addCard([], { type: "weather" }, "w");
        expect(cards).toEqual([{ id: "w", type: "weather", x: 0, y: 0, w: 3, h: 2 }]);
        expect(panelCardsSchema.safeParse(cards).success).toBe(true);
    });

    it("asks Open-Meteo for the conditions now and today, at two decimals", () => {
        const url = forecastUrl(40.4168, -3.7038);
        expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
        expect(url.searchParams.get("latitude")).toBe("40.42");
        expect(url.searchParams.get("longitude")).toBe("-3.70");
        expect(url.searchParams.get("current")).toBe("temperature_2m,weather_code");
        expect(url.searchParams.get("forecast_days")).toBe("1");
    });

    it("reads a forecast, and refuses one without a reading now", () => {
        expect(
            parseForecast({
                current: { temperature_2m: 21.4, weather_code: 3 },
                daily: { temperature_2m_max: [25.1], temperature_2m_min: [12] }
            })
        ).toEqual({ temperature: 21.4, code: 3, high: 25.1, low: 12 });
        expect(parseForecast({ current: { temperature_2m: 20 } })).toBeNull();
        expect(parseForecast("nonsense")).toBeNull();
        expect(
            parseForecast({ current: { temperature_2m: 5, weather_code: 71 } })
        ).toMatchObject({ high: null, low: null });
    });

    it("groups WMO codes for their icon", () => {
        expect(weatherGroup(0)).toBe("clear");
        expect(weatherGroup(2)).toBe("partly");
        expect(weatherGroup(48)).toBe("fog");
        expect(weatherGroup(81)).toBe("rain");
        expect(weatherGroup(86)).toBe("snow");
        expect(weatherGroup(99)).toBe("storm");
        expect(weatherGroup(42)).toBeNull();
    });

    it("reads the route's answer and nothing else", () => {
        expect(parseWeatherAnswer({ located: false, weather: null })).toEqual({
            located: false,
            weather: null
        });
        expect(parseWeatherAnswer({ weather: null })).toBeNull();
    });
});

describe("panel style", () => {
    it("reads an empty or old row as the defaults", () => {
        expect(storedStyle({})).toEqual(DEFAULT_PANEL_STYLE);
        expect(storedStyle(null)).toEqual(DEFAULT_PANEL_STYLE);
        expect(storedStyle([])).toEqual(DEFAULT_PANEL_STYLE);
    });

    it("keeps the fields it knows when one is unknown", () => {
        expect(storedStyle({ theme: "dark", accent: "neon", screensaver: 7 })).toEqual({
            ...DEFAULT_PANEL_STYLE,
            theme: "dark"
        });
    });

    it("refuses a save with an unknown value", () => {
        expect(panelStyleSchema.safeParse(DEFAULT_PANEL_STYLE).success).toBe(true);
        expect(
            panelStyleSchema.safeParse({ ...DEFAULT_PANEL_STYLE, screensaver: 7 }).success
        ).toBe(false);
        expect(panelStyleSchema.safeParse({ theme: "dark" }).success).toBe(false);
    });

    it("goes dark at night only when asked", () => {
        const night = new Date(2026, 0, 1, 23);
        const day = new Date(2026, 0, 1, 12);
        expect(wallTheme("light", true, night)).toBe("dark");
        expect(wallTheme("light", true, day)).toBe("light");
        expect(wallTheme("auto", false, night)).toBe("auto");
    });

    it("draws an accent and a background, and nothing for the defaults", () => {
        expect(wallSurface({ accent: "default", background: "plain" })).toEqual({});
        const surface = wallSurface({ accent: "blue", background: "gradient" });
        expect(surface["--primary"]).toBe("217 91% 60%");
        expect(surface.background).toContain("hsl(var(--primary)");
    });
});

describe("screensaver drift", () => {
    it("keeps away from the edges and moves every step", () => {
        let last = driftPosition(0);
        for (let step = 1; step < 200; step++) {
            const at = driftPosition(step);
            for (const value of [at.left, at.top]) {
                expect(value).toBeGreaterThanOrEqual(25);
                expect(value).toBeLessThanOrEqual(75);
            }
            expect(at).not.toEqual(last);
            last = at;
        }
        expect(driftPosition(5)).toEqual(driftPosition(5));
    });
});

describe("device list", () => {
    const rooms = [
        { id: "k", name: "Kitchen", floor: "Ground" },
        { id: "b", name: "Bedroom", floor: "First" }
    ];
    const devices = Array.from({ length: 500 }, (_, i) => ({
        id: `d${i}`,
        name: `Lamp ${String(i).padStart(3, "0")}`,
        roomId: i % 3 === 0 ? "k" : i % 3 === 1 ? "b" : null
    }));

    it("groups by floor and room, a device in none last", () => {
        const rows = listRows(devices, rooms, "");
        const groups = rows.filter((row) => row.kind === "group");
        expect(groups.map((row) => (row.kind === "group" ? row.room : ""))).toEqual([
            "Bedroom",
            "Kitchen",
            null
        ]);
        expect(rows.length).toBe(503);
    });

    it("searches name, room and floor, without accents or case", () => {
        expect(foldText("  Cocina  ÁTICO ")).toBe("cocina atico");
        const kitchen = listRows(devices, rooms, "ground lamp 003");
        expect(kitchen.map((row) => row.key)).toEqual(["group:k", "d3"]);
        expect(listRows(devices, rooms, "nothing here")).toEqual([]);
    });

    it("draws only the rows on screen, plus a margin", () => {
        expect(visibleRange(0, 560, 56, 503)).toEqual({ start: 0, end: 17 });
        expect(visibleRange(56 * 400, 560, 56, 503)).toEqual({ start: 394, end: 417 });
        expect(visibleRange(56 * 600, 560, 56, 503).end).toBe(503);
        expect(visibleRange(0, 560, 56, 0)).toEqual({ start: 0, end: 0 });
    });
});
