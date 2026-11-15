/**
 * A weather card's own settings: the geocoding answer a city search reads,
 * the card's stored shape (an older card reads as the place's weather with no
 * forecast), the forecast days, and which answer a card draws.
 */

import { describe, expect, it } from "vitest";
import {
    GEOCODE_RESULTS,
    geocodeQuerySchema,
    geocodeUrl,
    parseGeocoding
} from "@polaris-app/places/src/lib/geocoding-kinds";
import { panelCardSchema, storedCards } from "@polaris-app/places/src/lib/panel-layout";
import { forecastUrl, parseForecast, parseWeatherAnswer } from "@polaris-app/places/src/lib/weather-kinds";

const MADRID = {
    id: 3117735,
    name: "Madrid",
    latitude: 40.416775,
    longitude: -3.70379,
    admin1: "Madrid",
    country: "Spain"
};

describe("geocoding", () => {
    it("reads a place, its region and country, kept to about a kilometre", () => {
        const places = parseGeocoding({
            results: [MADRID, { ...MADRID, id: 2, name: "Madrid", admin1: "Iowa", country: "United States" }]
        });
        expect(places[0]).toEqual({
            id: "3117735",
            name: "Madrid",
            detail: "Spain",
            latitude: 40.42,
            longitude: -3.7
        });
        expect(places[1].detail).toBe("Iowa, United States");
    });

    it("skips results that are not places, and reads a broken answer as none", () => {
        expect(
            parseGeocoding({ results: [{ name: "Nowhere" }, { ...MADRID, latitude: 123 }, MADRID] })
        ).toHaveLength(1);
        expect(parseGeocoding({})).toEqual([]);
        expect(parseGeocoding("nope")).toEqual([]);
        expect(parseGeocoding({ results: "x" })).toEqual([]);
    });

    it("keeps at most the bounded number of results", () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ ...MADRID, id: i }));
        expect(parseGeocoding({ results: many })).toHaveLength(GEOCODE_RESULTS);
    });

    it("asks with a bounded count in the reader's language", () => {
        const url = geocodeUrl("Madrid", "es-ES");
        expect(url.host).toBe("geocoding-api.open-meteo.com");
        expect(url.searchParams.get("count")).toBe(String(GEOCODE_RESULTS));
        expect(url.searchParams.get("language")).toBe("es");
        expect(url.searchParams.get("name")).toBe("Madrid");
    });

    it("folds the search's spaces and refuses one too short or too long", () => {
        expect(geocodeQuerySchema.parse("  New   York ")).toBe("New York");
        expect(geocodeQuerySchema.safeParse(" a ").success).toBe(false);
        expect(geocodeQuerySchema.safeParse("x".repeat(101)).success).toBe(false);
    });
});

describe("weather card config", () => {
    const box = { id: "w1", type: "weather", x: 0, y: 0, w: 3, h: 2 };

    it("reads an older card as the place's weather with no forecast", () => {
        expect(storedCards([box])[0]).toMatchObject({ location: null, forecast: false });
    });

    it("keeps a picked location and the forecast", () => {
        const card = panelCardSchema.parse({
            ...box,
            location: { name: "Madrid, Spain", latitude: 40.42, longitude: -3.7 },
            forecast: true
        });
        expect(card).toMatchObject({
            location: { name: "Madrid, Spain", latitude: 40.42, longitude: -3.7 },
            forecast: true
        });
    });

    it("refuses a location off the Earth or with no name", () => {
        const bad = [
            { name: "X", latitude: 91, longitude: 0 },
            { name: "X", latitude: 0, longitude: -181 },
            { name: "  ", latitude: 0, longitude: 0 },
            { name: "x".repeat(121), latitude: 0, longitude: 0 }
        ];
        for (const location of bad)
            expect(panelCardSchema.safeParse({ ...box, location }).success).toBe(false);
    });
});

describe("forecast days", () => {
    it("asks for five days and reads each whole one", () => {
        expect(forecastUrl(1, 2).searchParams.get("forecast_days")).toBe("5");
        const weather = parseForecast({
            current: { temperature_2m: 18, weather_code: 3 },
            daily: {
                time: ["2026-11-15", "2026-11-16", "2026-11-17"],
                weather_code: [3, 61, null],
                temperature_2m_max: [20, 15, 14],
                temperature_2m_min: [10, 8, 7]
            }
        });
        expect(weather?.high).toBe(20);
        expect(weather?.days).toEqual([
            { date: "2026-11-15", code: 3, high: 20, low: 10 },
            { date: "2026-11-16", code: 61, high: 15, low: 8 }
        ]);
    });

    it("reads a route answer with a card's own weather", () => {
        const answer = parseWeatherAnswer({
            located: false,
            weather: null,
            cards: { w1: { temperature: 5, code: 0, high: null, low: null }, w2: null }
        });
        expect(answer?.cards?.w1?.temperature).toBe(5);
        expect(answer?.cards?.w2).toBeNull();
    });
});
