"use client";

/**
 * The wall's screensaver: after a while without a touch, the cards give way to
 * a dim clock and the weather on black, moved to a new spot every minute so no
 * pixel stays lit in one place long enough to burn in. With reduced motion the
 * clock jumps to its new spot instead of gliding there. A touch, a click or a
 * key wakes the wall, and that first touch presses nothing underneath.
 *
 * A dialog open on the wall (a camera full screen, a "Run?" question) holds it
 * off: somebody is reading it.
 */

import { useCallback, useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { driftPosition } from "./panel-state";
import { WeatherIcon } from "./panel-weather";
import { hostUi } from "@polaris/app-host/client";
import type { WeatherState } from "./panel-weather";

const { useDisplayFormat } = hostUi.displayFormat;
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
const DRIFT_MS = 60_000;

/** Whether nobody has touched the wall for `minutes`; never when 0. */
export function useIdle(minutes: number): { idle: boolean; wake: () => void } {
    const [idle, setIdle] = useState(false);
    useEffect(() => {
        if (minutes <= 0 || idle) return;
        let timer: ReturnType<typeof setTimeout>;
        const check = () => {
            if (document.querySelector('[role="dialog"], [role="alertdialog"]')) reset();
            else setIdle(true);
        };
        const reset = () => {
            clearTimeout(timer);
            timer = setTimeout(check, minutes * 60_000);
        };
        reset();
        for (const name of ACTIVITY) window.addEventListener(name, reset, { passive: true });
        return () => {
            clearTimeout(timer);
            for (const name of ACTIVITY) window.removeEventListener(name, reset);
        };
    }, [minutes, idle]);
    const wake = useCallback(() => setIdle(false), []);
    return { idle, wake };
}

export function PanelScreensaver({
    weather,
    onWake
}: {
    weather: WeatherState;
    onWake: () => void;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const locale = hostUi.i18nProvider.useLocale();
    const [now, setNow] = useState(() => new Date());
    const [step, setStep] = useState(0);
    useEffect(() => {
        const clock = setInterval(() => setNow(new Date()), 15_000);
        const drift = setInterval(() => setStep((value) => value + 1), DRIFT_MS);
        const key = () => onWake();
        window.addEventListener("keydown", key);
        return () => {
            clearInterval(clock);
            clearInterval(drift);
            window.removeEventListener("keydown", key);
        };
    }, [onWake]);
    const at = driftPosition(step);
    const reading =
        weather.state === "ready" && weather.answer.weather ? weather.answer.weather : null;

    return (
        <div
            role="button"
            tabIndex={0}
            aria-label={t("panelWall.wake")}
            onClick={onWake}
            className="fixed inset-0 z-[100] cursor-pointer overflow-hidden bg-black text-white"
        >
            <div
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center opacity-80 transition-[left,top] duration-[30000ms] ease-in-out motion-reduce:transition-none"
                style={{ left: `${at.left}%`, top: `${at.top}%` }}
            >
                <span className="text-7xl font-light tabular-nums sm:text-8xl">
                    {format.time(now)}
                </span>
                <span className="text-lg text-white/70">
                    {new Intl.DateTimeFormat(locale, {
                        weekday: "long",
                        day: "numeric",
                        month: "long"
                    }).format(now)}
                </span>
                {reading ? (
                    <span className="flex items-center gap-2 text-2xl text-white/80 tabular-nums">
                        <WeatherIcon code={reading.code} className="size-7" />
                        {format.temperature(reading.temperature)}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
