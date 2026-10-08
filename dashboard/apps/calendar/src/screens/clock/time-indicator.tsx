"use client";

/**
 * Beside the bell on every screen: the timer that ends soonest (or the
 * stopwatch) while one is running, and nothing at all otherwise. Pressing it
 * opens the Time area on that tab.
 *
 * It is also what rings. Mounted on every page, it knows when each alarm and
 * timer is due and rings it in the page - the sound, and a dialog to stop,
 * snooze or add a minute - whatever screen is open. One tab per browser rings
 * a given ring; the server rings it for everybody else (the bell, the desktop
 * app, whatever routes the person set up) when no tab stopped it first.
 *
 * The pill counts every second; what it says on hover does not. A browser
 * hides a tooltip whose text changes and shows it again, so a label carrying
 * the countdown blinked once a second and could not be read. The hover says
 * what does not move - the timer's name and when it ends - and the count stays
 * in the pill.
 */

import Link from "next/link";
import { useEffect, type ReactElement } from "react";
import { hostUi } from "@polaris/app-host/client";
import { useCalendarT } from "../i18n";
import { Timer, Watch } from "lucide-react";
import * as model from "../../lib/clock/model";
import { lengthText } from "./words";
import { RingDialog, useRinger } from "./ringer";
import { useClock, useServerNow } from "./store";

export function TimeIndicator() {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const clock = useClock();
    const snapshot = clock.snapshot;
    const running = snapshot?.timers.filter((timer) => timer.endsAt !== null) ?? [];
    const watchRunning = snapshot?.stopwatch.startedAt != null;
    const counting = running.length > 0 || watchRunning;
    const now = useServerNow(clock.skew, 1000, counting);
    const ringer = useRinger(clock);

    // Something counting on another device is picked up once a minute while it
    // counts; nothing is asked while nothing does.
    usePoll(counting, clock.refresh);

    if (!clock.allowed) return null;

    const soonest = [...running].sort(
        (a, b) => new Date(a.endsAt!).getTime() - new Date(b.endsAt!).getTime()
    )[0];

    let pill: ReactElement | null = null;
    if (soonest) {
        const left = model.timerRemaining(soonest, now);
        const name =
            soonest.label ||
            (soonest.pomodoro
                ? t(`time.focus.phase.${soonest.pomodoro.phase}`)
                : t("time.timers.untitled", { length: lengthText(soonest.durationMs, t) }));
        const ends = new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
            hour12: format.preferences.clock === "12h"
        }).format(new Date(soonest.endsAt!));
        const label = t("time.indicator.timerEnds", { name, time: ends });
        pill = (
            <Link
                href="/calendar/time?tab=timers"
                className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[0.8125rem] font-medium tabular-nums text-foreground transition-colors hover:bg-muted"
                aria-label={label}
                title={label}
            >
                <Timer aria-hidden className="size-4 shrink-0 text-primary" />
                <span>{model.formatCountdown(left)}</span>
                {running.length > 1 ? (
                    <span className="rounded bg-muted px-1 text-[0.6875rem] text-muted-foreground">
                        {`+${running.length - 1}`}
                    </span>
                ) : null}
            </Link>
        );
    } else if (watchRunning && snapshot) {
        const reading = model.formatClockMs(model.stopwatchElapsed(snapshot.stopwatch, now));
        const label = t("time.indicator.stopwatchRunning");
        pill = (
            <Link
                href="/calendar/time?tab=stopwatch"
                className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[0.8125rem] font-medium tabular-nums text-foreground transition-colors hover:bg-muted"
                aria-label={label}
                title={label}
            >
                <Watch aria-hidden className="size-4 shrink-0 text-primary" />
                <span>{reading}</span>
            </Link>
        );
    }

    return (
        <>
            {pill}
            <RingDialog ringer={ringer} />
        </>
    );
}

/** Read again once a minute while `active` and the tab is in view. */
function usePoll(active: boolean, refresh: () => void): void {
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, 60_000);
        return () => window.clearInterval(timer);
    }, [active, refresh]);
}
