/**
 * A timer key whose timer is kept in Polaris: one of the account's Calendar
 * timers, a new one made on the first press, or the focus cycle.
 *
 * Polaris sends when a running timer ends and its own clock at that reading;
 * the key counts down between readings from those two, with the deck's clock
 * corrected by the difference (the skew Calendar's screens apply), so the key
 * and every Calendar screen reach zero on the same second.
 *
 * Shared with the Companion module. SDK-free and pure, so the tests reach it.
 */

import type { Gesture } from "./presses";
import type { DeckState } from "./polaris";

/** The catalogue entry a Polaris timer key runs. */
export const CALENDAR_TIMER = "calendar.timer";

/** Where a timer key's timer is kept. Absent - every key set before Polaris
 *  timers existed - is the deck. */
export type TimerSource = "deck" | "polaris";

/** What a press does, as Calendar's Time screen names it. */
export type TimerOp = "toggle" | "reset" | "add" | "skip" | "shift";

export type Countdown = NonNullable<DeckState["countdown"]>;

/** The settings of a timer key, local or not. */
export type TimerKeySettings = {
    source?: TimerSource;
    mode?: "countdown" | "stopwatch";
    minutes?: number;
    /** Which Polaris timer: "new", "focus" or one of the account's, by id. */
    polarisTimer?: string;
    /** A new Polaris timer's name, which is how it is found again. */
    polarisName?: string;
};

export function sourceOf(settings: { source?: unknown } | null | undefined): TimerSource {
    return settings?.source === "polaris" ? "polaris" : "deck";
}

/** The minutes a key is set to, kept to what a key can be set to. */
export function minutesOf(settings: TimerKeySettings): number {
    const minutes = Math.round(Number(settings.minutes));
    return Number.isFinite(minutes) ? Math.min(1440, Math.max(1, minutes)) : 5;
}

/** What a Polaris timer key is run and watched with. */
export function polarisOptions(settings: TimerKeySettings): {
    timer: string;
    name: string;
    minutes: number;
} {
    return {
        timer: settings.polarisTimer?.trim() || "new",
        name: settings.polarisName?.trim() ?? "",
        minutes: minutesOf(settings)
    };
}

/** A press starts or pauses, a hold resets, and a double press adds a minute -
 *  or, on the focus cycle, skips to the next phase. */
export function opFor(gesture: Gesture, timer: string): TimerOp {
    if (gesture === "hold") return "reset";
    if (gesture === "double") return timer === "focus" ? "skip" : "add";
    return "toggle";
}

/** A reading's skew: how far Polaris's clock is ahead of the deck's. */
export function skewOf(countdown: Countdown | undefined, receivedAt: number): number {
    return countdown?.serverNow === undefined ? 0 : countdown.serverNow - receivedAt;
}

/** What is left at `now` on the deck's clock, never below zero. */
export function remainingAt(countdown: Countdown, now: number, skewMs: number): number {
    if (countdown.state === "running" && countdown.endsAt !== undefined)
        return Math.max(0, countdown.endsAt - (now + skewMs));
    return Math.max(0, countdown.remainingMs);
}

/** "4:59" or "1:02:03", rounded up so it reads 0:00 only once it is over. */
export function timeText(ms: number): string {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A running countdown that has reached zero here, before Polaris says so. */
export function finishedAt(countdown: Countdown, now: number, skewMs: number): boolean {
    return (
        countdown.state === "rung" ||
        (countdown.state === "running" && remainingAt(countdown, now, skewMs) === 0)
    );
}

function faceOf(state: DeckState, countdown: Countdown): DeckState {
    const running = countdown.state === "running";
    const rung = countdown.state === "rung";
    return {
        ...state,
        tone: running ? "ok" : rung ? "bad" : "idle",
        icon: running ? "timer" : rung ? "bell-ring" : "pause",
        on: running,
        value: timeText(countdown.remainingMs),
        countdown
    };
}

/**
 * What a press shows before Polaris answers, from what the key shows now at
 * `now` on the deck's clock. Null when the key cannot know ahead - a phase to
 * skip, a timer not read yet - and waits for the answer instead.
 */
export function predictTimer(
    state: DeckState | undefined,
    op: TimerOp,
    now: number,
    skewMs: number,
    step = 0
): DeckState | null {
    const countdown = state?.countdown;
    if (!state || !countdown) return null;
    const serverNow = now + skewMs;
    const left = remainingAt(countdown, now, skewMs);
    const running = (remainingMs: number): Countdown => ({
        ...countdown,
        state: "running",
        remainingMs,
        endsAt: serverNow + remainingMs,
        serverNow
    });
    const stopped = (status: "paused" | "idle", remainingMs: number): Countdown => {
        const { endsAt: _endsAt, serverNow: _serverNow, ...rest } = countdown;
        return { ...rest, state: status, remainingMs };
    };
    switch (op) {
        case "toggle":
            if (countdown.state === "running") return faceOf(state, stopped("paused", left));
            return faceOf(state, running(countdown.state === "rung" ? countdown.durationMs : left));
        case "reset":
            // A focus cycle goes back to its first phase, whose length the key
            // may not hold: that one waits for Polaris.
            if (countdown.phase !== undefined) return null;
            return faceOf(state, stopped("idle", countdown.durationMs));
        case "add":
        case "shift": {
            const delta = (op === "add" ? 1 : step) * 60_000;
            if (delta === 0) return null;
            if (countdown.state === "running")
                return faceOf(state, running(Math.max(1000, left + delta)));
            if (countdown.state === "rung") return delta > 0 ? faceOf(state, running(delta)) : null;
            const next = Math.max(1000, left + delta);
            return faceOf(
                state,
                countdown.state === "idle"
                    ? { ...stopped("idle", next), durationMs: next }
                    : stopped("paused", next)
            );
        }
        case "skip":
            return null;
    }
}
