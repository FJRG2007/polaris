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
 *
 * Every open Polaris shows the ring - each tab of each browser, the desktop
 * app, a phone - so it can be stopped from wherever somebody is. Only one of
 * them makes the sound: the client the server elected (`thisClientRings`), and
 * within it one tab (`claim`). The election is read again while it rings, so
 * the sound moves if that client closes or somebody sits down at another one.
 * Stopping it anywhere has to reach every other: the stop is written on the row
 * (`stoppedDue`), and while something shows here the snapshot is read again
 * every few seconds so the ring goes wherever it was answered. Tabs of this
 * browser hear sooner, over the clock's broadcast channel.
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
/** How often a ringing screen asks whether it was answered somewhere else. */
const ANSWERED_POLL_MS = 4_000;

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

/**
 * Whether a ring was answered somewhere - stopped or snoozed on another tab or
 * device, or its alarm or timer deleted. The scheduler moving a ring on is not
 * an answer: it does that whether or not anybody heard it.
 */
export function answered(ring: Ring, snapshot: model.ClockSnapshot): boolean {
    const rows: readonly { id: string; stoppedDue: string | null }[] =
        ring.kind === "alarm" ? snapshot.alarms : snapshot.timers;
    const row = rows.find((entry) => entry.id === ring.id);
    if (!row) return true;
    return (
        row.stoppedDue !== null &&
        new Date(row.stoppedDue).getTime() === new Date(ring.due).getTime()
    );
}

/**
 * Whether a ring is still owed according to the server, read now. The snapshot
 * a tab holds can be a minute old - a window in the background reads again only
 * that often - and a timer deleted or stopped on another device in that minute
 * must not ring here. A read that fails rings anyway: an alarm that stays quiet
 * because the network blinked is the worse mistake.
 */
export async function stillOwed(ring: Ring, read: () => Promise<Response> = fresh): Promise<boolean> {
    try {
        const response = await read();
        if (!response.ok) return true;
        const snapshot = (await response.json()) as model.ClockSnapshot;
        return ringsOf(snapshot).some((entry) => entry.key === ring.key) && !answered(ring, snapshot);
    } catch {
        return true;
    }
}

function fresh(): Promise<Response> {
    return fetch("/api/calendar/time", { cache: "no-store" });
}

/** How often a ringing screen asks again whether it is the one to sound. */
const ELECTION_POLL_MS = 2_000;

/**
 * Whether this client is the one the server elected to make the account's
 * sounds. A dashboard that does not offer the answer rings: an alarm rung
 * twice is better than one rung nowhere.
 */
export function soundsHere(): boolean {
    try {
        return hostUi.soundingClient.thisClientRings();
    } catch {
        return true;
    }
}

/** Claim the sound of a ring for this tab: false when another tab of this
 *  browser has it. Which client sounds at all is `soundsHere`. */
export async function claim(key: string): Promise<boolean> {
    const take = (): boolean => {
        try {
            const raw = window.localStorage.getItem(RANG_KEY);
            const rang = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
            if (rang[key]) return false;
            const now = Date.now();
            for (const [old, at] of Object.entries(rang))
                if (now - at > 86_400_000) delete rang[old];
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
    const claimed = useRef(new Set<string>());
    const [elected, setElected] = useState(soundsHere);
    const snapshot = clock.snapshot;
    const skew = clock.skew;
    const refreshClock = clock.refresh;

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
                if (now - local > LATE_MS || answered(ring, snapshot)) continue;
                void (async () => {
                    if (!(await stillOwed(ring))) {
                        // Changed somewhere else since this tab last read:
                        // read again, so what it shows catches up as well.
                        refreshClock();
                        return;
                    }
                    // Shown in every tab; the sound is this tab's only if it
                    // claims it first among the tabs of this browser.
                    if (await claim(ring.key)) claimed.current.add(ring.key);
                    setRings((current) =>
                        current.some((entry) => entry.key === ring.key)
                            ? current
                            : [...current, ring]
                    );
                })();
            } else soonest = Math.min(soonest, local);
        }
        if (soonest === Infinity) return;
        const timer = window.setTimeout(
            () => setTurn((value) => value + 1),
            Math.min(soonest - now, LONGEST_WAIT_MS)
        );
        return () => window.clearTimeout(timer);
    }, [snapshot, skew, turn, clock.allowed, refreshClock]);

    // A tab that was behind others catches up the moment it is looked at.
    useEffect(() => {
        const wake = () => setTurn((value) => value + 1);
        document.addEventListener("visibilitychange", wake);
        return () => document.removeEventListener("visibilitychange", wake);
    }, []);

    // A ring answered on another tab or device stops here too.
    useEffect(() => {
        if (!snapshot) return;
        setRings((current) => {
            const left = current.filter((ring) => !answered(ring, snapshot));
            return left.length === current.length ? current : left;
        });
    }, [snapshot]);

    // While something rings, keep asking whether it was answered elsewhere.
    const ringing = rings.length > 0;
    const refresh = clock.refresh;
    useEffect(() => {
        if (!ringing) return;
        const timer = window.setInterval(refresh, ANSWERED_POLL_MS);
        return () => window.clearInterval(timer);
    }, [ringing, refresh]);

    // Whether this client is still the one to sound, asked again while it
    // rings so the sound follows the election.
    useEffect(() => {
        if (!ringing) return;
        setElected(soundsHere());
        const timer = window.setInterval(() => setElected(soundsHere()), ELECTION_POLL_MS);
        return () => window.clearInterval(timer);
    }, [ringing]);

    // One sound at a time: the first ring's, in the one tab of the one client
    // that sounds.
    const first = rings[0];
    const loud = !!first && elected && claimed.current.has(first.key);
    useEffect(() => {
        if (!first || !loud) return;
        return playRing(first.sound);
    }, [first, loud]);

    const done = useCallback(
        (ring: Ring) => setRings((current) => current.filter((entry) => entry.key !== ring.key)),
        []
    );
    const failed = useCallback(
        (message: string) =>
            toast.show({ key: "calendar-time", title: message || t("screen.failed") }),
        [toast, t]
    );

    const stop = useCallback(
        (ring: Ring) => {
            done(ring);
            void mutate(
                clock,
                () =>
                    ring.kind === "alarm"
                        ? clockActions.changeAlarmAction({
                              id: ring.id,
                              change: "dismiss",
                              due: ring.due
                          })
                        : clockActions.changeTimerAction({
                              id: ring.id,
                              change: "dismiss",
                              due: ring.due
                          }),
                null,
                failed
            );
        },
        [clock, done, failed]
    );

    const snooze = useCallback(
        (ring: Ring) => {
            done(ring);
            void mutate(
                clock,
                () =>
                    clockActions.changeAlarmAction({
                        id: ring.id,
                        change: "snooze",
                        due: ring.due
                    }),
                null,
                failed
            );
        },
        [clock, done, failed]
    );

    const addMinute = useCallback(
        (ring: Ring) => {
            done(ring);
            void (async () => {
                const stopped = await mutate(
                    clock,
                    () =>
                        clockActions.changeTimerAction({
                            id: ring.id,
                            change: "dismiss",
                            due: ring.due
                        }),
                    null,
                    failed
                );
                if (stopped)
                    await mutate(
                        clock,
                        () => clockActions.changeTimerAction({ id: ring.id, change: "addMinute" }),
                        null,
                        failed
                    );
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
                            {t(
                                next.phase === "focus"
                                    ? "time.notify.nextFocus"
                                    : "time.notify.nextBreak",
                                {
                                    minutes: next[next.phase]
                                }
                            )}
                        </p>
                    ) : null}
                    {ringer.rings.length > 1 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("time.ring.more", { count: ringer.rings.length - 1 })}
                        </p>
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
