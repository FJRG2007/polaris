/**
 * The weather at a wall panel's place, from the place's own location.
 *
 * Asked of Open-Meteo through the host's guarded fetch, with its time and byte
 * ceiling, and kept for ten minutes per coordinate: every wall at a place, and
 * every place at the same spot, costs one request in that time. A failure is
 * kept for two minutes, so a service that is down is not asked on every
 * refresh.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { forecastUrl, parseForecast, type PanelWeather, type WeatherAnswer } from "./weather-kinds";

const KEEP_MS = 10 * 60_000;
const KEEP_FAILED_MS = 2 * 60_000;
/** Far more than a one-day answer is. */
const ANSWER_BYTES = 64 * 1024;
const KEPT_MAX = 500;

const kept = new Map<string, { at: number; weather: PanelWeather | null }>();
const asking = new Map<string, Promise<PanelWeather | null>>();

async function ask(latitude: number, longitude: number): Promise<PanelWeather | null> {
    try {
        const response = await host.safeFetch.follow(
            forecastUrl(latitude, longitude),
            "application/json"
        );
        if (!response) return null;
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const bytes = await host.safeFetch.readCapped(response, ANSWER_BYTES);
        if (!bytes) return null;
        return parseForecast(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

/** The weather at a coordinate now, or null when the service did not answer. */
export async function weatherAt(
    latitude: number,
    longitude: number,
    now = Date.now()
): Promise<PanelWeather | null> {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const hit = kept.get(key);
    if (hit && now - hit.at < (hit.weather ? KEEP_MS : KEEP_FAILED_MS)) return hit.weather;
    const pending = asking.get(key);
    if (pending) return pending;
    const request = ask(latitude, longitude).then((weather) => {
        kept.delete(key);
        if (kept.size >= KEPT_MAX) kept.delete(kept.keys().next().value!);
        kept.set(key, { at: now, weather });
        return weather;
    });
    asking.set(key, request);
    try {
        return await request;
    } finally {
        asking.delete(key);
    }
}

/** The weather a panel shows, or null when the panel is not this install's. */
export async function panelWeather(
    installedAppId: string,
    panelId: string
): Promise<WeatherAnswer | null> {
    const row = await prisma.placePanel.findFirst({
        where: { id: panelId, installedAppId },
        select: { place: { select: { latitude: true, longitude: true } } }
    });
    if (!row) return null;
    const { latitude, longitude } = row.place;
    if (latitude === null || longitude === null) return { located: false, weather: null };
    return { located: true, weather: await weatherAt(latitude, longitude) };
}

/** Forget every kept answer. For tests. */
export function forgetWeather(): void {
    kept.clear();
    asking.clear();
}
