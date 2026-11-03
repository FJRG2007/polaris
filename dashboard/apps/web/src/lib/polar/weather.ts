/**
 * `polar_weather`: the current conditions and the days ahead for a place, so
 * Polar answers a weather question with real figures and draws them as a
 * weather card (`polar_show`, kind `weather`).
 *
 * The data is Open-Meteo's (https://open-meteo.com/en/docs): free, no key, and
 * two public endpoints - the geocoding search turns a place name into
 * coordinates, the forecast answers for those coordinates. Both go through the
 * guarded fetch (`safe-fetch.ts`), with its time and byte ceiling, and both
 * answers are checked against a schema before a figure is used. Nothing the
 * model wrote becomes an address: the host is fixed, and its words only reach
 * the query string.
 *
 * It reaches outside the instance, so it rides the same switch as the web
 * tools: offered only while the administrator allows the web and the person
 * left it on.
 *
 * Server-only.
 */

import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { follow, readCapped } from "@/lib/safe-fetch";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { POLAR_VISUAL_TOOL, weatherCodeOf } from "@/lib/polar/visuals";

export const WEATHER_TOOL = "polar_weather";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
/** Far more than either answer is: a geocoding answer for one place, or a week. */
const ANSWER_BYTES = 256 * 1024;

const CURRENT_FIELDS = [
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "weather_code",
    "wind_speed_10m"
] as const;
const DAILY_FIELDS = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max"
] as const;

/** The geocoding answer, as much of it as is read. No `results` means no match. */
const geocodingSchema = z.object({
    results: z
        .array(
            z.object({
                name: z.string().min(1),
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                country: z.string().optional(),
                admin1: z.string().optional(),
                timezone: z.string().optional()
            })
        )
        .optional()
});

type GeoMatch = NonNullable<z.infer<typeof geocodingSchema>["results"]>[number];

const reading = z.number().finite().nullable().optional();
const forecastSchema = z.object({
    timezone: z.string().optional(),
    current: z
        .object({
            time: z.string(),
            temperature_2m: reading,
            apparent_temperature: reading,
            relative_humidity_2m: reading,
            weather_code: reading,
            wind_speed_10m: reading
        })
        .optional(),
    daily: z
        .object({
            time: z.array(z.string()),
            weather_code: z.array(z.number().nullable()),
            temperature_2m_max: z.array(z.number().nullable()),
            temperature_2m_min: z.array(z.number().nullable()),
            precipitation_probability_max: z.array(z.number().nullable()).optional()
        })
        .optional()
});

type Forecast = z.infer<typeof forecastSchema>;

export const weatherInput = z.object({
    place: z.string().trim().min(1).max(120).describe("The city or place, as the person named it."),
    country: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional()
        .describe("ISO 3166-1 alpha-2 country code, to tell apart places that share a name."),
    language: z
        .string()
        .regex(/^[a-z]{2}$/)
        .default("en")
        .describe("Two-letter language code for the place's name, such as en or es."),
    units: z.enum(["metric", "imperial"]).default("metric"),
    days: z.number().int().min(1).max(7).default(7)
});
export type WeatherInput = z.infer<typeof weatherInput>;

/** What the forecast came to, shaped like the weather view's own fields. */
export interface WeatherReport {
    ok: true;
    place: string;
    timezone: string | null;
    units: WeatherInput["units"];
    asOf?: string;
    current?: {
        temperature: number;
        apparent?: number;
        code: number;
        wind?: number;
        humidity?: number;
    };
    days: { date: string; min: number; max: number; code: number; precipitation?: number }[];
    text: string;
}
export interface WeatherRefusal {
    ok: false;
    text: string;
}

/** A name from another service, one line and bounded. */
function clean(value: string | undefined): string {
    return (value ?? "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 60);
}

async function getJson<T>(url: URL, schema: z.ZodType<T>): Promise<T | "unreachable" | "bad"> {
    const response = await follow(url, "application/json");
    if (!response) return "unreachable";
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return "bad";
    }
    const bytes = await readCapped(response, ANSWER_BYTES);
    if (!bytes) return "bad";
    try {
        const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : "bad";
    } catch {
        return "bad";
    }
}

const UNREACHABLE: WeatherRefusal = {
    ok: false,
    text: "The weather service could not be reached from this Polaris: it may have no internet connection right now. Tell the person so; do not guess the weather."
};
const BROKEN: WeatherRefusal = {
    ok: false,
    text: "The weather service answered with something unreadable. Tell the person the forecast is not available right now; do not guess the weather."
};

/** The current conditions and the days ahead for `input.place`. */
export async function fetchWeather(input: WeatherInput): Promise<WeatherReport | WeatherRefusal> {
    const geocoding = new URL(GEOCODING_URL);
    geocoding.search = new URLSearchParams({
        name: input.place,
        count: "1",
        language: input.language,
        format: "json",
        ...(input.country ? { countryCode: input.country.toUpperCase() } : {})
    }).toString();
    const found = await getJson(geocoding, geocodingSchema);
    if (found === "unreachable") return UNREACHABLE;
    if (found === "bad") return BROKEN;
    const match = found.results?.[0];
    if (!match) {
        return {
            ok: false,
            text: `No place called "${input.place}" was found. Ask the person which place they mean, or try its name in English.`
        };
    }

    const forecast = new URL(FORECAST_URL);
    forecast.search = new URLSearchParams({
        latitude: String(match.latitude),
        longitude: String(match.longitude),
        current: CURRENT_FIELDS.join(","),
        daily: DAILY_FIELDS.join(","),
        timezone: "auto",
        forecast_days: String(input.days),
        temperature_unit: input.units === "imperial" ? "fahrenheit" : "celsius",
        wind_speed_unit: input.units === "imperial" ? "mph" : "kmh"
    }).toString();
    const data = await getJson(forecast, forecastSchema);
    if (data === "unreachable") return UNREACHABLE;
    if (data === "bad") return BROKEN;
    return reportOf(match, data, input);
}

/** The forecast answer as a report: a missing reading is left out, never
 *  invented, and a day with no temperatures or code is dropped. Pure. */
export function reportOf(
    match: GeoMatch,
    data: Forecast,
    input: Pick<WeatherInput, "units">
): WeatherReport {
    const place = [...new Set([clean(match.name), clean(match.admin1), clean(match.country)])]
        .filter(Boolean)
        .join(", ")
        .slice(0, 120);
    const number = (value: number | null | undefined) =>
        typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const now = data.current;
    const nowCode = number(now?.weather_code);
    const nowTemperature = number(now?.temperature_2m);
    const current =
        now && nowCode !== undefined && weatherCodeOf(nowCode) && nowTemperature !== undefined
            ? {
                  temperature: nowTemperature,
                  code: nowCode,
                  ...(number(now.apparent_temperature) !== undefined
                      ? { apparent: number(now.apparent_temperature) }
                      : {}),
                  ...(number(now.wind_speed_10m) !== undefined
                      ? { wind: number(now.wind_speed_10m) }
                      : {}),
                  ...(number(now.relative_humidity_2m) !== undefined
                      ? { humidity: number(now.relative_humidity_2m) }
                      : {})
              }
            : undefined;
    const daily = data.daily;
    const days: WeatherReport["days"] = [];
    for (const [index, date] of (daily?.time ?? []).entries()) {
        if (!daily || days.length >= 7 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const code = number(daily.weather_code[index]);
        const min = number(daily.temperature_2m_min[index]);
        const max = number(daily.temperature_2m_max[index]);
        if (code === undefined || !weatherCodeOf(code) || min === undefined || max === undefined)
            continue;
        const precipitation = number(daily.precipitation_probability_max?.[index]);
        days.push({
            date,
            min: Math.min(min, max),
            max: Math.max(min, max),
            code,
            ...(precipitation !== undefined ? { precipitation } : {})
        });
    }
    const asOf =
        now && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(now.time) ? now.time.slice(0, 16) : undefined;
    return {
        ok: true,
        place,
        timezone: data.timezone ?? match.timezone ?? null,
        units: input.units,
        ...(asOf ? { asOf } : {}),
        ...(current ? { current } : {}),
        days,
        text: `Weather for ${place}, from Open-Meteo. Show it with ${POLAR_VISUAL_TOOL}, view kind "weather", copying place, asOf, units, current and days exactly as given here, then add at most a sentence of your own.`
    };
}

const DESCRIPTION =
    "Get the current weather and the daily forecast (up to 7 days) for a place, from Open-Meteo. Use it whenever the person asks about the weather, temperature, rain or wind somewhere; never answer the weather from memory. Then show the result with polar_show, kind weather.";

export function polarWeatherTools(): ToolSet {
    return {
        [WEATHER_TOOL]: tool({
            description: DESCRIPTION,
            inputSchema: polarInputSchema(weatherInput),
            async execute(input) {
                const parsed = weatherInput.safeParse(input);
                if (!parsed.success) return { ok: false, text: "That place could not be read." };
                return fetchWeather(parsed.data);
            }
        })
    };
}
