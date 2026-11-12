/**
 * The weather a wall panel shows: what is read of an Open-Meteo forecast
 * (https://open-meteo.com/en/docs), the service Polar already answers weather
 * questions with, and how a WMO weather code is drawn.
 *
 * Pure and client-safe: the server parses the answer with it and the wall
 * draws the result with it.
 */

import { z } from "zod";

export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Icon groups a weather code is drawn with. */
export const WEATHER_GROUPS = [
    "clear",
    "partly",
    "cloudy",
    "fog",
    "drizzle",
    "rain",
    "snow",
    "storm"
] as const;
export type WeatherGroup = (typeof WEATHER_GROUPS)[number];

/** The conditions now and today's range, in Celsius. */
export interface PanelWeather {
    readonly temperature: number;
    readonly code: number;
    readonly high: number | null;
    readonly low: number | null;
}

/** What the wall's weather route answers. */
export interface WeatherAnswer {
    /** Null when the place has no location, or the service did not answer. */
    readonly weather: PanelWeather | null;
    /** Whether the panel's place has a location to ask about. */
    readonly located: boolean;
}

/** The forecast address for a coordinate: the conditions now and today. */
export function forecastUrl(latitude: number, longitude: number): URL {
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
        latitude: latitude.toFixed(2),
        longitude: longitude.toFixed(2),
        current: "temperature_2m,weather_code",
        daily: "temperature_2m_max,temperature_2m_min",
        timezone: "auto",
        forecast_days: "1"
    }).toString();
    return url;
}

const reading = z.number().finite().nullable().optional();
const forecastSchema = z.object({
    current: z.object({ temperature_2m: reading, weather_code: reading }).optional(),
    daily: z
        .object({
            temperature_2m_max: z.array(z.number().finite().nullable()).optional(),
            temperature_2m_min: z.array(z.number().finite().nullable()).optional()
        })
        .optional()
});

/** A forecast answer, or null when it holds no reading now. */
export function parseForecast(body: unknown): PanelWeather | null {
    const parsed = forecastSchema.safeParse(body);
    if (!parsed.success) return null;
    const now = parsed.data.current;
    if (typeof now?.temperature_2m !== "number" || typeof now.weather_code !== "number")
        return null;
    return {
        temperature: now.temperature_2m,
        code: Math.round(now.weather_code),
        high: parsed.data.daily?.temperature_2m_max?.[0] ?? null,
        low: parsed.data.daily?.temperature_2m_min?.[0] ?? null
    };
}

/** How a WMO weather interpretation code is drawn. Null for one it does not
 *  know. */
export function weatherGroup(code: number): WeatherGroup | null {
    if (code === 0) return "clear";
    if (code === 1 || code === 2) return "partly";
    if (code === 3) return "cloudy";
    if (code === 45 || code === 48) return "fog";
    if (code >= 51 && code <= 57) return "drizzle";
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if (code >= 95 && code <= 99) return "storm";
    return null;
}

const answerSchema = z.object({
    located: z.boolean(),
    weather: z
        .object({
            temperature: z.number().finite(),
            code: z.number().int(),
            high: z.number().finite().nullable(),
            low: z.number().finite().nullable()
        })
        .nullable()
});

/** The route's answer as the browser reads it, or null when it is not one. */
export function parseWeatherAnswer(body: unknown): WeatherAnswer | null {
    const parsed = answerSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
}
