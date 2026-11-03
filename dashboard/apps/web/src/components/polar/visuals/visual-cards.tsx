"use client";

/**
 * The answer cards Polar draws for a question of a known shape
 * (`lib/polar/visuals.ts`): a translation, the weather, the time in other
 * places and a conversion. Each fits the message column at any width; a long
 * value wraps or truncates with the whole of it in its title.
 *
 * Nothing here reaches the network: language names and times come from the
 * runtime's `Intl`, and "Listen" is the browser's own speech synthesis.
 */

import { cn, CopyIcon, useCopied } from "@polaris/ui";
import { MessageAction } from "@/components/polar/elements/message";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSnow,
    CloudSun,
    Droplets,
    Info,
    Sun,
    Square,
    Volume2,
    Wind,
    type LucideProps
} from "lucide-react";
import * as visuals from "@/lib/polar/visuals";

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** A voice on this device for `tag`, the exact language first; null when the
 *  device has none and the browser picks its own. */
export function localVoiceFor(
    voices: readonly SpeechSynthesisVoice[],
    tag: string
): SpeechSynthesisVoice | null {
    const wanted = tag.toLowerCase();
    const primary = wanted.split("-")[0] ?? wanted;
    const local = voices.filter((voice) => voice.localService);
    return (
        local.find((voice) => voice.lang.toLowerCase() === wanted) ??
        local.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === primary) ??
        null
    );
}

function canSpeak(): boolean {
    return (
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        typeof window.SpeechSynthesisUtterance === "function"
    );
}

export function TranslationCard({ view }: { view: visuals.TranslationView }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const from = visuals.sourceLanguageOf(view);
    const fromName = from ? visuals.languageName(from, locale) : t("visual.translation.detected");
    const toName = visuals.languageName(view.to, locale);
    const { copied, copy } = useCopied();
    // Known only in the browser, so the first paint matches the server's.
    const [speech, setSpeech] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const started = useRef(false);
    useEffect(() => {
        setSpeech(canSpeak());
        return () => {
            if (started.current && canSpeak()) window.speechSynthesis.cancel();
        };
    }, []);

    const listen = () => {
        const synth = window.speechSynthesis;
        synth.cancel();
        if (speaking) {
            setSpeaking(false);
            return;
        }
        const utterance = new window.SpeechSynthesisUtterance(view.translation);
        utterance.lang = view.to;
        const voice = localVoiceFor(synth.getVoices(), view.to);
        if (voice) utterance.voice = voice;
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);
        started.current = true;
        setSpeaking(true);
        synth.speak(utterance);
    };

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2">
                <section className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 px-3 py-2">
                    <h4
                        className="truncate text-xs font-medium text-muted-foreground"
                        title={fromName}
                    >
                        {fromName}
                    </h4>
                    <p
                        lang={from ?? undefined}
                        className="whitespace-pre-wrap break-words text-sm text-foreground"
                    >
                        {view.source}
                    </p>
                </section>
                <section className="flex min-w-0 flex-col gap-1 rounded-md bg-primary/5 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <h4
                            className="min-w-0 flex-1 truncate text-xs font-medium text-primary"
                            title={toName}
                        >
                            {toName}
                        </h4>
                        {speech ? (
                            <MessageAction
                                label={
                                    speaking
                                        ? t("visual.translation.stop")
                                        : t("visual.translation.listen")
                                }
                                aria-pressed={speaking}
                                onClick={listen}
                            >
                                {speaking ? <Square /> : <Volume2 />}
                            </MessageAction>
                        ) : null}
                        <MessageAction
                            label={
                                copied
                                    ? t("visual.translation.copied")
                                    : t("visual.translation.copy")
                            }
                            onClick={() => void copy(view.translation)}
                        >
                            <CopyIcon copied={copied} />
                        </MessageAction>
                    </div>
                    <p
                        lang={view.to}
                        className="whitespace-pre-wrap break-words text-base font-medium text-foreground"
                    >
                        {view.translation}
                    </p>
                </section>
            </div>
            {view.alternatives?.length ? (
                <p className="min-w-0 break-words text-sm text-muted-foreground">
                    <span className="font-medium">{t("visual.translation.alternatives")}:</span>{" "}
                    <span lang={view.to}>{view.alternatives.join("; ")}</span>
                </p>
            ) : null}
            {view.notes?.trim() ? (
                <p className="flex min-w-0 items-start gap-1.5 text-xs text-foreground-subtle">
                    <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">{view.notes}</span>
                </p>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

const WEATHER_ICONS: Record<visuals.WeatherGroup, ComponentType<LucideProps>> = {
    clear: Sun,
    partly: CloudSun,
    cloudy: Cloud,
    fog: CloudFog,
    drizzle: CloudDrizzle,
    rain: CloudRain,
    snow: CloudSnow,
    storm: CloudLightning
};

function useWeatherLabel() {
    const t = useTranslations("polar");
    return (code: number) => {
        const entry = visuals.weatherCodeOf(code);
        return entry ? t(`visual.weather.codes.${entry.key}`) : String(code);
    };
}

function WeatherIcon({ code, className }: { code: number; className?: string }) {
    const Icon = WEATHER_ICONS[visuals.weatherCodeOf(code)?.group ?? "cloudy"];
    return <Icon className={cn("shrink-0", className)} aria-hidden />;
}

/** A local `YYYY-MM-DD[THH:mm]` read as written: formatted in UTC so the
 *  reader's own zone never moves it. */
function wallDate(value: string): Date {
    const [date = "", time = "00:00"] = value.split("T");
    return new Date(`${date}T${time}:00Z`);
}

export function WeatherCard({ view }: { view: visuals.WeatherView }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const label = useWeatherLabel();
    const unit = visuals.weatherUnits(view.units);
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const degrees = (value: number) => `${whole.format(value)}${unit.temperature}`;
    const now = view.current;
    const asOf = view.asOf
        ? new Intl.DateTimeFormat(locale, {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
              timeZone: "UTC"
          }).format(wallDate(view.asOf))
        : null;
    const day = new Intl.DateTimeFormat(locale, {
        weekday: "short",
        day: "numeric",
        timeZone: "UTC"
    });
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground" title={view.place}>
                    {view.place}
                </span>
                {asOf ? (
                    <span className="truncate text-xs text-muted-foreground">
                        {t("visual.weather.asOf", { time: asOf })}
                    </span>
                ) : null}
            </div>
            {now ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex min-w-0 items-center gap-3">
                        <WeatherIcon code={now.code} className="size-10 text-primary" />
                        <div className="flex min-w-0 flex-col">
                            <span className="text-3xl font-semibold tabular-nums text-foreground">
                                {degrees(now.temperature)}
                            </span>
                            <span
                                className="truncate text-sm text-muted-foreground"
                                title={label(now.code)}
                            >
                                {label(now.code)}
                            </span>
                        </div>
                    </div>
                    <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                        {now.apparent !== undefined ? (
                            <li className="truncate">
                                {t("visual.weather.feelsLike", { value: degrees(now.apparent) })}
                            </li>
                        ) : null}
                        {now.wind !== undefined ? (
                            <li className="flex min-w-0 items-center gap-1">
                                <Wind className="size-3.5 shrink-0" aria-hidden />
                                <span className="truncate">
                                    {t("visual.weather.wind", {
                                        value: `${whole.format(now.wind)} ${unit.wind}`
                                    })}
                                </span>
                            </li>
                        ) : null}
                        {now.humidity !== undefined ? (
                            <li className="flex min-w-0 items-center gap-1">
                                <Droplets className="size-3.5 shrink-0" aria-hidden />
                                <span className="truncate">
                                    {t("visual.weather.humidity", {
                                        value: `${whole.format(now.humidity)}%`
                                    })}
                                </span>
                            </li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {view.days?.length ? (
                <ul
                    className="flex min-w-0 flex-col border-t border-border pt-2"
                    aria-label={t("visual.weather.forecast")}
                >
                    {view.days.map((entry) => (
                        <li
                            key={entry.date}
                            className="grid min-w-0 grid-cols-[minmax(3.5rem,auto)_auto_minmax(0,1fr)_auto_auto] items-center gap-2 py-1 text-sm"
                        >
                            <span className="truncate text-muted-foreground">
                                {day.format(wallDate(entry.date))}
                            </span>
                            <WeatherIcon code={entry.code} className="size-4 text-foreground" />
                            <span
                                className="min-w-0 truncate text-xs text-muted-foreground"
                                title={label(entry.code)}
                            >
                                {label(entry.code)}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-primary">
                                {entry.precipitation !== undefined && entry.precipitation > 0
                                    ? t("visual.weather.rain", {
                                          value: `${whole.format(entry.precipitation)}%`
                                      })
                                    : null}
                            </span>
                            <span className="shrink-0 tabular-nums">
                                <span className="text-muted-foreground">{degrees(entry.min)}</span>{" "}
                                <span className="font-medium text-foreground">
                                    {degrees(entry.max)}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** How often a "now" card moves its clocks. */
const TICK_MS = 15_000;

export function TimeCard({ view }: { view: visuals.TimeView }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const live = !view.at;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, [live]);
    const instant = visuals.timeInstant(view, now);
    const offsets = visuals.timeOffsets(view, instant);
    const difference = (minutes: number) => {
        if (minutes === 0) return t("visual.time.same");
        const hours = Math.floor(Math.abs(minutes) / 60);
        const rest = Math.abs(minutes) % 60;
        const value = rest
            ? t("visual.time.hoursMinutes", { hours, minutes: rest })
            : t("visual.time.hours", { hours });
        return minutes > 0 ? t("visual.time.ahead", { value }) : t("visual.time.behind", { value });
    };
    return (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
            {view.places.map((place, index) => {
                const time = new Intl.DateTimeFormat(locale, {
                    timeZone: place.zone,
                    hour: "numeric",
                    minute: "2-digit"
                }).format(instant);
                const date = new Intl.DateTimeFormat(locale, {
                    timeZone: place.zone,
                    weekday: "short",
                    day: "numeric",
                    month: "short"
                }).format(instant);
                return (
                    <li
                        key={`${place.zone}-${index}`}
                        className="flex min-w-0 items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                        <div className="flex min-w-0 flex-col">
                            <span
                                className="truncate text-sm font-medium text-foreground"
                                title={place.label}
                            >
                                {place.label}
                            </span>
                            <span
                                className="truncate text-xs text-muted-foreground"
                                title={place.zone}
                            >
                                {index === 0
                                    ? live
                                        ? t("visual.time.now")
                                        : place.zone
                                    : difference(offsets[index] ?? 0)}
                            </span>
                        </div>
                        <div className="flex shrink-0 flex-col items-end">
                            <time
                                suppressHydrationWarning={live}
                                dateTime={new Date(instant).toISOString()}
                                className="text-2xl font-semibold tabular-nums text-foreground"
                            >
                                {time}
                            </time>
                            <span
                                suppressHydrationWarning={live}
                                className="text-xs text-muted-foreground"
                            >
                                {date}
                            </span>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function ConversionCard({ view }: { view: visuals.ConversionView }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const from = visuals.amountText(view.from, view.type, locale);
    const to = visuals.amountText(view.to, view.type, locale);
    const how = visuals.rateText(view, locale) ?? view.formula?.trim();
    const asOf = view.asOf
        ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
              wallDate(view.asOf)
          )
        : null;
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm text-muted-foreground" title={from}>
                {from} =
            </span>
            <output
                className="truncate text-3xl font-semibold tabular-nums text-foreground"
                title={to}
            >
                {to}
            </output>
            {how ? (
                <span className="truncate text-xs text-muted-foreground" title={how}>
                    {how}
                </span>
            ) : null}
            {view.type === "currency" && view.source ? (
                <span className="truncate text-xs text-foreground-subtle" title={view.source}>
                    {t("visual.conversion.source", { source: view.source })}
                    {asOf ? `, ${t("visual.conversion.asOf", { date: asOf })}` : ""}
                </span>
            ) : null}
        </div>
    );
}
