/**
 * `polar_weather`: a place is geocoded and its forecast read from Open-Meteo
 * through the guarded fetch, both answers checked before a figure is used,
 * and what comes back is exactly what a weather card takes. An instance that
 * cannot reach the service says so instead of guessing.
 *
 * The answers below are trimmed copies of what Open-Meteo returned for Madrid
 * on 2026-11-03.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const answers: { url: string; body: unknown }[] = [];
const asked: URL[] = [];
let unreachable = false;

vi.mock("@/lib/safe-fetch", () => ({
    follow: vi.fn(async (url: URL) => {
        asked.push(url);
        if (unreachable) return null;
        const answer = answers.find((entry) => url.href.startsWith(entry.url));
        return {
            ok: Boolean(answer),
            body: { cancel: async () => undefined },
            text: JSON.stringify(answer?.body ?? null)
        };
    }),
    readCapped: vi.fn(async (response: { text: string }) => new TextEncoder().encode(response.text))
}));

const { fetchWeather, reportOf, polarWeatherTools, WEATHER_TOOL } =
    await import("@/lib/polar/weather");
const { polarVisualSchema } = await import("@/lib/polar/visuals");

const GEOCODING = {
    results: [
        {
            id: 3117735,
            name: "Madrid",
            latitude: 40.4165,
            longitude: -3.70256,
            elevation: 665,
            feature_code: "PPLC",
            country_code: "ES",
            timezone: "Europe/Madrid",
            population: 3255944,
            country: "Spain",
            admin1: "Madrid"
        }
    ],
    generationtime_ms: 0.5
};
const FORECAST = {
    latitude: 40.39599,
    longitude: -3.6793447,
    utc_offset_seconds: 3600,
    timezone: "Europe/Madrid",
    current_units: { time: "iso8601", temperature_2m: "°C" },
    current: {
        time: "2026-11-03T10:45",
        interval: 900,
        temperature_2m: 10.1,
        apparent_temperature: 5.6,
        relative_humidity_2m: 46,
        weather_code: 0,
        wind_speed_10m: 15
    },
    daily: {
        time: ["2026-11-03", "2026-11-04", "2026-11-05"],
        weather_code: [3, 61, null],
        temperature_2m_max: [14.3, 14, 15],
        temperature_2m_min: [6.3, 3.8, 2],
        precipitation_probability_max: [0, 87, null]
    }
};

beforeEach(() => {
    answers.length = 0;
    asked.length = 0;
    unreachable = false;
    answers.push(
        { url: "https://geocoding-api.open-meteo.com/v1/search", body: GEOCODING },
        { url: "https://api.open-meteo.com/v1/forecast", body: FORECAST }
    );
});

const input = { place: "Madrid", language: "es", units: "metric" as const, days: 7 };

describe("polar_weather", () => {
    it("asks Open-Meteo's two fixed endpoints with the documented parameters", async () => {
        await fetchWeather({ ...input, country: "es", units: "imperial", days: 3 });
        expect(asked).toHaveLength(2);
        const [geocoding, forecast] = asked as [URL, URL];
        expect(geocoding.origin + geocoding.pathname).toBe(
            "https://geocoding-api.open-meteo.com/v1/search"
        );
        expect(Object.fromEntries(geocoding.searchParams)).toEqual({
            name: "Madrid",
            count: "1",
            language: "es",
            format: "json",
            countryCode: "ES"
        });
        expect(forecast.origin + forecast.pathname).toBe("https://api.open-meteo.com/v1/forecast");
        expect(Object.fromEntries(forecast.searchParams)).toEqual({
            latitude: "40.4165",
            longitude: "-3.70256",
            current:
                "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
            daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            timezone: "auto",
            forecast_days: "3",
            temperature_unit: "fahrenheit",
            wind_speed_unit: "mph"
        });
    });

    it("keeps a place's words out of the address: only the query string carries them", async () => {
        await fetchWeather({ ...input, place: "@evil.example/../x?y=1#z" });
        expect(asked[0]!.host).toBe("geocoding-api.open-meteo.com");
        expect(asked[0]!.searchParams.get("name")).toBe("@evil.example/../x?y=1#z");
    });

    it("answers with figures a weather card takes as they are", async () => {
        const report = await fetchWeather(input);
        expect(report.ok).toBe(true);
        if (!report.ok) return;
        expect(report.place).toBe("Madrid, Spain");
        expect(report.asOf).toBe("2026-11-03T10:45");
        expect(report.current).toEqual({
            temperature: 10.1,
            apparent: 5.6,
            code: 0,
            wind: 15,
            humidity: 46
        });
        // The day with no weather code is left out, not invented.
        expect(report.days).toEqual([
            { date: "2026-11-03", min: 6.3, max: 14.3, code: 3, precipitation: 0 },
            { date: "2026-11-04", min: 3.8, max: 14, code: 61, precipitation: 87 }
        ]);
        const view = {
            kind: "weather",
            place: report.place,
            asOf: report.asOf,
            units: report.units,
            current: report.current,
            days: report.days
        };
        expect(polarVisualSchema.safeParse({ view }).success).toBe(true);
    });

    it("says so when the instance cannot reach the service", async () => {
        unreachable = true;
        const report = await fetchWeather(input);
        expect(report).toEqual({
            ok: false,
            text: expect.stringContaining("could not be reached")
        });
    });

    it("asks which place when none matches", async () => {
        answers[0] = { url: answers[0]!.url, body: { generationtime_ms: 0.1 } };
        const report = await fetchWeather(input);
        expect(report.ok).toBe(false);
        expect(report.text).toContain('No place called "Madrid"');
        expect(asked).toHaveLength(1);
    });

    it("refuses an answer that is not the documented shape", async () => {
        answers[1] = { url: answers[1]!.url, body: { daily: { time: "nope" } } };
        const report = await fetchWeather(input);
        expect(report).toEqual({ ok: false, text: expect.stringContaining("unreadable") });
    });

    it("leaves out readings the service did not have", () => {
        const report = reportOf(
            { name: "Nowhere", latitude: 0, longitude: 0 },
            {
                current: {
                    time: "2026-11-03T10:45",
                    temperature_2m: null,
                    weather_code: 0
                }
            },
            { units: "metric" }
        );
        expect(report.current).toBeUndefined();
        expect(report.days).toEqual([]);
    });

    it("is a tool the model can call", () => {
        const tools = polarWeatherTools();
        expect(Object.keys(tools)).toEqual([WEATHER_TOOL]);
        expect(String((tools[WEATHER_TOOL] as { description?: string }).description)).toContain(
            "polar_show"
        );
    });
});
