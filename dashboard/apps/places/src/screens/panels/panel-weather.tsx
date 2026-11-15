"use client";

/**
 * The weather on a wall: asked of the panel's weather route while the wall is
 * visible, again every fifteen minutes, and drawn from the last answer kept in
 * the browser while the next one is on its way.
 */

import { Button, cn, Skeleton } from "@polaris/ui";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import {
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSnow,
    CloudSun,
    MapPin,
    Sun,
    Thermometer
} from "lucide-react";
import {
    parseWeatherAnswer,
    weatherGroup,
    type PanelWeather,
    type WeatherAnswer,
    type WeatherGroup
} from "../../lib/weather-kinds";

const { useDisplayFormat } = hostUi.displayFormat;
const { useLocale } = hostUi.i18nProvider;

const REFRESH_MS = 15 * 60_000;
const KEPT_PREFIX = "polaris.wall.weather:";

export type WeatherState =
    | { readonly state: "loading" }
    | { readonly state: "failed" }
    | { readonly state: "ready"; readonly answer: WeatherAnswer };

function readKept(url: string): WeatherAnswer | null {
    try {
        const raw = localStorage.getItem(KEPT_PREFIX + url);
        return raw ? parseWeatherAnswer(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function keep(url: string, answer: WeatherAnswer): void {
    try {
        localStorage.setItem(KEPT_PREFIX + url, JSON.stringify(answer));
    } catch {
        // Private window or full storage: the next visit asks again.
    }
}

/** The weather a panel shows. Asks nothing while `enabled` is false. */
export function usePanelWeather(url: string | null, enabled: boolean): WeatherState {
    const [weather, setWeather] = useState<WeatherState>({ state: "loading" });
    useEffect(() => {
        if (!url || !enabled) return;
        let gone = false;
        const kept = readKept(url);
        if (kept) setWeather({ state: "ready", answer: kept });
        const ask = async () => {
            if (document.visibilityState !== "visible") return;
            const body = await fetch(url, { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .catch(() => null);
            if (gone) return;
            const answer = parseWeatherAnswer(body);
            if (answer) {
                keep(url, answer);
                setWeather({ state: "ready", answer });
            } else setWeather((now) => (now.state === "ready" ? now : { state: "failed" }));
        };
        void ask();
        const timer = setInterval(() => void ask(), REFRESH_MS);
        const visibility = () => {
            if (document.visibilityState === "visible") void ask();
        };
        document.addEventListener("visibilitychange", visibility);
        return () => {
            gone = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, [url, enabled]);
    return weather;
}

/** What one weather card shows: the place's weather, or the weather at the
 *  location set on the card, which the route answers by card id. A card set
 *  to a location the last answer does not know yet is still loading. */
export function cardWeather(
    weather: WeatherState,
    card: { readonly id: string; readonly location?: unknown }
): WeatherState {
    if (!card.location || weather.state !== "ready") return weather;
    const cards = weather.answer.cards;
    if (!cards || !(card.id in cards)) return { state: "loading" };
    return { state: "ready", answer: { located: true, weather: cards[card.id] ?? null } };
}

const ICONS: Record<WeatherGroup, typeof Sun> = {
    clear: Sun,
    partly: CloudSun,
    cloudy: Cloud,
    fog: CloudFog,
    drizzle: CloudDrizzle,
    rain: CloudRain,
    snow: CloudSnow,
    storm: CloudLightning
};

export function WeatherIcon({ code, className }: { code: number; className?: string }) {
    const group = weatherGroup(code);
    const Icon = group ? ICONS[group] : Thermometer;
    return <Icon className={cn("shrink-0", className)} aria-hidden />;
}

/** The temperature, the sky in words, and today's range. */
export function WeatherReading({
    weather,
    large = false,
    forecast = false
}: {
    weather: PanelWeather;
    large?: boolean;
    /** The next days under it, when the answer holds them. */
    forecast?: boolean;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const locale = useLocale();
    const group = weatherGroup(weather.code);
    const days = forecast ? (weather.days ?? []).slice(1) : [];
    const now = (
        <div className="flex min-w-0 items-center gap-3">
            <WeatherIcon code={weather.code} className={large ? "size-14" : "size-10"} />
            <div className="flex min-w-0 flex-col">
                <span
                    className={cn(
                        "font-semibold tabular-nums",
                        large ? "text-5xl" : "text-3xl"
                    )}
                >
                    {format.temperature(weather.temperature)}
                </span>
                <span className="min-w-0 truncate text-lg text-muted-foreground">
                    {group ? t(`panelWeather.${group}`) : t("panelWeather.unknown")}
                </span>
                {weather.high !== null && weather.low !== null ? (
                    <span className="min-w-0 truncate text-base text-muted-foreground tabular-nums">
                        {t("panelWeather.range", {
                            high: format.temperature(weather.high),
                            low: format.temperature(weather.low)
                        })}
                    </span>
                ) : null}
            </div>
        </div>
    );
    if (days.length === 0) return now;
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return (
        <div className="flex min-w-0 flex-col gap-3">
            {now}
            <ul className="flex min-w-0 gap-3 overflow-hidden" aria-label={t("weatherCard.nextDays")}>
                {days.map((day) => (
                    <li key={day.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                        <span className="truncate text-base text-muted-foreground">
                            {weekday.format(new Date(`${day.date}T12:00:00Z`))}
                        </span>
                        <WeatherIcon code={day.code} className="size-6" />
                        <span className="truncate text-base tabular-nums">
                            {format.temperature(day.high)}
                            <span className="text-muted-foreground"> {format.temperature(day.low)}</span>
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** A weather card's face. `onPick` offers choosing a location where there is
 *  none, to somebody who may set one. */
export function WeatherFace({
    weather,
    forecast = false,
    onPick
}: {
    weather: WeatherState;
    forecast?: boolean;
    onPick?: () => void;
}) {
    const t = usePlacesT();
    if (weather.state === "loading")
        return (
            <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-7 w-20" />
                    <Skeleton className="h-4 w-28" />
                </div>
            </div>
        );
    if (weather.state === "failed")
        return <p className="text-lg text-muted-foreground">{t("panelWeather.failed")}</p>;
    if (!weather.answer.located)
        return onPick ? (
            <Button type="button" variant="outline" onClick={onPick}>
                <MapPin className="size-4 shrink-0" />
                {t("weatherCard.pick")}
            </Button>
        ) : (
            <p className="text-lg text-muted-foreground">{t("panelWeather.noLocation")}</p>
        );
    if (!weather.answer.weather)
        return <p className="text-lg text-muted-foreground">{t("panelWeather.failed")}</p>;
    return <WeatherReading weather={weather.answer.weather} forecast={forecast} />;
}
