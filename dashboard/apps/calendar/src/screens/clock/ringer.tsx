"use client";

/**
 * Ringing an alarm or a timer in the page: when each is due, which tab of this
 * browser rings it, the sound, and the dialog that stops, snoozes or adds a
 * minute.
 *
 * The server rings the same ring a few seconds later as a notification - the
 * bell, the desktop app, whatever routes the person set up - unless this page
 * stopped it first, in which case it says nothing. A ring found more than a
 * minute late (the computer slept) is left to the server, which already told
 * the person.
 */

import { useCalendarT } from "../i18n";
import { hostUi } from "@polaris/app-host/client";
import { ring as playRing } from "./sound";
import * as model from "../../lib/clock/model";
import { mutate, type ClockRead } from "./store";
import * as clockActions from "../../actions/clock";
import { AlarmClock, BellOff, Plus, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogContent, DialogTitle, useToast } from "@polaris/ui";

/** A ring this late is the server's to tell, not a sound out of nowhere. */
const LATE_MS = 60_000;
/** The longest one wait is set for; longer ones are worked out again then. */
const LONGEST_WAIT_MS = 6 * 60 * 60_000;
const RANG_KEY = "polaris.clock.rang";

export interface Ring {
    readonly key: string;
    readonly kind: "alarm" | "timer";
    readonly id: string;
    /** When it was due, on the server's clock. */
    readonly due: string;
    readonly sound: model.ClockSound;
    readonly label: string;
    readonly snoozeMinutes: number;
    readonly pomodoro: model.PomodoroState | null;
}

/** What is due and when, from a snapshot. */
export function ringsOf(snapshot: model.ClockSnapshot): Ring[] {
    const rings: Ring[] = [];
    for (const alarm of snapshot.alarms) {
        if (!alarm.enabled || !alarm.nextFireAt) continue;
        rings.push({
            key: `alarm:${alarm.id}:${alarm.nextFireAt}`,
            kind: "alarm",
            id: alarm.id,
            due: alarm.nextFireAt,
            sound: alarm.sound,
            label: alarm.label,
            snoozeMinutes: alarm.snoozeMinutes,
            pomodoro: null
        });
    }
    for (const timer of snapshot.timers) {
        if (!timer.endsAt) continue;
        rings.push({
            key: `timer:${timer.id}:${timer.endsAt}`,
            kind: "timer",
            id: timer.id,
            due: timer.endsAt,
            sound: timer.sound,
            label: timer.label,
            snoozeMinutes: 0,
            pomodoro: timer.pomodoro
        });
    }
    return rings.sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
}

/** Claim a ring for this tab: false when another tab of this browser has it. */
async function claim(key: string): Promise<boolean> {
    const take = (): boolean => {
        try {
            const raw = window.localStorage.getItem(RANG_KEY);
            const rang = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
            if (rang[key]) return false;
            const now = Date.now();
            for (const [old, at] of Object.entries(rang)) if (now - at > 86_400_000) delete rang[old];
            rang[key] = now;
            window.localStorage.setItem(RANG_KEY, JSON.stringify(rang));
            return true;
        } catch {
            // Storage refused: this tab rings, as it would alone.
            return true;
        }
    };
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return take();
    return locks.request("polaris-clock-ring", () => take());
}

export interface Ringer {
    readonly rings: readonly Ring[];
    readonly stop: (ring: Ring) => void;
    readonly snooze: (ring: Ring) => void;
    readonly addMinute: (ring: Ring) => void;
}

export function useRinger(clock: ClockRead): Ringer {
    const t = useCalendarT();
    const toast = useToast();
    const [rings, setRings] = useState<Ring[]>([]);
    const [turn, setTurn] = useState(0);
    const heard = useRef(new Set<string>());
    const snapshot = clock.snapshot;
    const skew = clock.skew;

    // Wait for the next ring, ring what is due, and wait again.
    useEffect(() => {
        if (!snapshot || !clock.allowed) return;
        const now = Date.now();
        const pending = ringsOf(snapshot).filter((ring) => !heard.current.has(ring.key));
        let soonest = Infinity;
        for (const ring of pending) {
            const local = new Date(ring.due).getTime() - skew;
            if (local <= now) {
                heard.current.add(ring.key);
                if (now - local > LATE_MS) continue;
                void claim(ring.key).then((mine) => {
                    if (mine) setRings((current) => (current.some((entry) => entry.key === ring.key) ? current : [...current, ring]));
                });
            } else soonest = Math.min(soonest, local);
        }
        if (soonest === Infinity) return;
        const timer = window.setTimeout(() => setTurn((value) => value + 1), Math.min(soonest - now, LONGEST_WAIT_MS));
        return () => window.clearTimeout(timer);
    }, [snapshot, skew, turn, clock.allowed]);

    // A tab that was behind others catches up the moment it is looked at.
    useEffect(() => {
        const wake = () => setTurn((value) => value + 1);
        document.addEventListener("visibilitychange", wake);
        return () => document.removeEventListener("visibilitychange", wake);
    }, []);

    // One sound at a time: the first ring's.
    const first = rings[0];
    useEffect(() => {
        if (!first) return;
        return playRing(first.sound);
    }, [first]);

    const done = useCallback((ring: Ring) => setRings((current) => current.filter((entry) => entry.key !== ring.key)), []);
    const failed = useCallback(
        (message: string) => toast.show({ key: "calendar-time", title: message || t("screen.failed") }),
        [toast, t]
    );

    const stop = useCallback(
        (ring: Ring) => {
            done(ring);
            void mutate(
                clock,
                () =>
                    ring.kind === "alarm"
                        ? clockActions.changeAlarmAction({ id: ring.id, change: "dismiss", due: ring.due })
                        : clockActions.changeTimerAction({ id: ring.id, change: "dismiss" }),
                null,
                failed
            );
        },
        [clock, done, failed]
    );

    const snooze = useCallback(
        (ring: Ring) => {
            done(ring);
            void mutate(clock, () => clockActions.changeAlarmAction({ id: ring.id, change: "snooze" }), null, failed);
        },
        [clock, done, failed]
    );

    const addMinute = useCallback(
        (ring: Ring) => {
            done(ring);
            void (async () => {
                const stopped = await mutate(
                    clock,
                    () => clockActions.changeTimerAction({ id: ring.id, change: "dismiss" }),
                    null,
                    failed
                );
                if (stopped)
                    await mutate(clock, () => clockActions.changeTimerAction({ id: ring.id, change: "addMinute" }), null, failed);
            })();
        },
        [clock, done, failed]
    );

    return { rings, stop, snooze, addMinute };
}

export function RingDialog({ ringer }: { ringer: Ringer }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const ring = ringer.rings[0];
    if (!ring) return null;
    const cycle = ring.pomodoro;
    const title =
        ring.label ||
        (cycle
            ? t(`time.notify.phaseDone.${cycle.phase}`)
            : ring.kind === "alarm"
              ? t("time.notify.alarm")
              : t("time.notify.timer"));
    const next = cycle ? model.nextPhase(cycle) : null;
    const Icon = ring.kind === "alarm" ? AlarmClock : Timer;

    return (
        <Dialog open onOpenChange={(open) => !open && ringer.stop(ring)}>
            <DialogContent className="max-w-sm" showClose={false}>
                <div className="flex flex-col items-center gap-3 py-2 text-center">
                    <Icon aria-hidden className="size-10 animate-pulse text-primary" />
                    <DialogTitle className="text-lg">{title}</DialogTitle>
                    <p className="text-3xl font-semibold tabular-nums">
                        {ring.kind === "alarm"
                            ? new Intl.DateTimeFormat(locale, {
                                  hour: "numeric",
                                  minute: "2-digit",
                                  hour12: format.preferences.clock === "12h"
                              }).format(new Date(ring.due))
                            : model.formatClockMs(0)}
                    </p>
                    {next ? (
                        <p className="text-[0.8125rem] text-muted-foreground">
                            {t(next.phase === "focus" ? "time.notify.nextFocus" : "time.notify.nextBreak", {
                                minutes: next[next.phase]
                            })}
                        </p>
                    ) : null}
                    {ringer.rings.length > 1 ? (
                        <p className="text-xs text-muted-foreground">{t("time.ring.more", { count: ringer.rings.length - 1 })}</p>
                    ) : null}
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                    {ring.kind === "alarm" ? (
                        <Button variant="outline" onClick={() => ringer.snooze(ring)}>
                            {t("time.ring.snooze", { minutes: ring.snoozeMinutes })}
                        </Button>
                    ) : !cycle ? (
                        <Button variant="outline" onClick={() => ringer.addMinute(ring)}>
                            <Plus />
                            {t("time.timers.addMinute")}
                        </Button>
                    ) : null}
                    <Button autoFocus onClick={() => ringer.stop(ring)}>
                        <BellOff />
                        {t("time.ring.stop")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
