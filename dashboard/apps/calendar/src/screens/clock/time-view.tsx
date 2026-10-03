"use client";

/**
 * Calendar's Time area: alarms, timers (with focus cycles), the stopwatch and
 * the world clock with its meeting planner, one tab each.
 *
 * The tabs and their frames are drawn at once; only the lists wait for the
 * read, which paints from what this tab kept the last time. The tab is in the
 * address (`?tab=`), so a notification or the header's indicator opens the
 * right one.
 */

import { useMemo } from "react";
import { useClock } from "./store";
import { displayZone } from "../time";
import { useCalendarT } from "../i18n";
import { WorldPanel } from "./world-panel";
import { AlarmsPanel } from "./alarms-panel";
import { TimersPanel } from "./timers-panel";
import { SegmentedControl } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { StopwatchPanel } from "./stopwatch-panel";
import * as preferenceActions from "../../actions/preferences";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_PREFERENCES, type CalendarPreferences } from "../../lib/preferences";

export const TIME_TABS = ["alarms", "timers", "stopwatch", "world"] as const;
export type TimeTab = (typeof TIME_TABS)[number];

export function TimeView() {
    const t = useCalendarT();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const asked = params.get("tab");
    const tab: TimeTab = (TIME_TABS as readonly string[]).includes(asked ?? "")
        ? (asked as TimeTab)
        : "alarms";
    const format = hostUi.displayFormat.useDisplayFormat();
    const preferencesRead = useCachedRead<CalendarPreferences>(
        cacheKey("preferences"),
        async () =>
            (await unwrap(() => preferenceActions.loadPreferencesAction(), t("screen.failed")))
                .preferences
    );
    const preferences = preferencesRead.data ?? DEFAULT_PREFERENCES;
    const zone = displayZone(preferences.timezone, format.preferences.timeZone);
    const hour12 = format.preferences.clock === "12h";
    const clock = useClock();

    const options = useMemo(
        () => [
            { value: "alarms" as const, label: t("time.tabs.alarms") },
            { value: "timers" as const, label: t("time.tabs.timers") },
            { value: "stopwatch" as const, label: t("time.tabs.stopwatch") },
            { value: "world" as const, label: t("time.tabs.world") }
        ],
        [t]
    );

    const choose = (next: TimeTab) => {
        const query = new URLSearchParams(params.toString());
        query.set("tab", next);
        router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Four tabs do not fit a phone at their full names, and cut down
                to "Alar..." they say nothing: the row scrolls instead. */}
            <div className="max-w-full self-start overflow-x-auto overscroll-x-contain">
                <SegmentedControl
                    aria-label={t("time.tabs.label")}
                    value={tab}
                    onValueChange={choose}
                    options={options}
                    className="w-max max-w-none"
                />
            </div>
            {tab === "alarms" ? (
                <AlarmsPanel clock={clock} zone={zone} hour12={hour12} />
            ) : tab === "timers" ? (
                <TimersPanel
                    clock={clock}
                    pomodoro={preferences.pomodoro}
                    onPomodoro={(pomodoro) =>
                        preferencesRead.data &&
                        void unwrap(
                            () => preferenceActions.savePreferencesAction({ pomodoro }),
                            t("screen.failed")
                        )
                            .then((answer) => preferencesRead.replace(answer.preferences))
                            .catch(() => undefined)
                    }
                />
            ) : tab === "stopwatch" ? (
                <StopwatchPanel clock={clock} />
            ) : (
                <WorldPanel
                    zone={zone}
                    hour12={hour12}
                    preferences={preferences}
                    ready={preferencesRead.data !== null}
                    onCities={async (worldClock) => {
                        const before = preferencesRead.data;
                        if (!before) return;
                        preferencesRead.replace({ ...before, worldClock });
                        try {
                            const answer = await unwrap(
                                () => preferenceActions.savePreferencesAction({ worldClock }),
                                t("screen.failed")
                            );
                            preferencesRead.replace(answer.preferences);
                        } catch (caught) {
                            preferencesRead.replace(before);
                            throw caught;
                        }
                    }}
                />
            )}
        </div>
    );
}
