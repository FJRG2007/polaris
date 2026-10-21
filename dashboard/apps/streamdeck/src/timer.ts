/**
 * A countdown or a stopwatch, kept in the plugin.
 *
 * Stored as when it started and how much had run before, never as a ticking
 * number, so the time on the key is right however late a redraw comes, and
 * survives the Stream Deck app restarting. Pure: every function takes `now`.
 */

export interface TimerState {
    /** "countdown" counts down from `durationMs`; "stopwatch" counts up. */
    readonly mode: "countdown" | "stopwatch";
    readonly durationMs: number;
    /** When it was last started, or null while paused or reset. */
    readonly startedAt: number | null;
    /** What had run before the last start. */
    readonly elapsedMs: number;
}

export const TIMER_LIMITS = {
    /** Longest countdown a dial can set: 24 hours. */
    maxMs: 24 * 60 * 60_000,
    /** One dial tick, in milliseconds. */
    stepMs: 60_000
} as const;

export function newTimer(mode: TimerState["mode"], durationMs = 5 * 60_000): TimerState {
    return { mode, durationMs: clampDuration(durationMs), startedAt: null, elapsedMs: 0 };
}

function clampDuration(ms: number): number {
    return Math.min(TIMER_LIMITS.maxMs, Math.max(TIMER_LIMITS.stepMs, Math.round(ms)));
}

export function elapsed(timer: TimerState, now: number): number {
    return timer.elapsedMs + (timer.startedAt === null ? 0 : Math.max(0, now - timer.startedAt));
}

export function running(timer: TimerState): boolean {
    return timer.startedAt !== null;
}

/** Whether a countdown has reached zero. A stopwatch never finishes. */
export function finished(timer: TimerState, now: number): boolean {
    return timer.mode === "countdown" && elapsed(timer, now) >= timer.durationMs;
}

/** Start, or pause. A finished countdown starts again from the top. */
export function toggle(timer: TimerState, now: number): TimerState {
    if (finished(timer, now)) return { ...timer, startedAt: now, elapsedMs: 0 };
    if (running(timer)) return { ...timer, startedAt: null, elapsedMs: elapsed(timer, now) };
    return { ...timer, startedAt: now };
}

export function reset(timer: TimerState): TimerState {
    return { ...timer, startedAt: null, elapsedMs: 0 };
}

/** A dial turn: the countdown's length, by whole minutes. Only while stopped. */
export function adjust(timer: TimerState, ticks: number): TimerState {
    if (running(timer) || timer.mode !== "countdown") return timer;
    return { ...timer, durationMs: clampDuration(timer.durationMs + ticks * TIMER_LIMITS.stepMs) };
}

/** What the key shows: time left for a countdown, time run for a stopwatch. */
export function display(timer: TimerState, now: number): string {
    const ms =
        timer.mode === "countdown"
            ? Math.max(0, timer.durationMs - elapsed(timer, now))
            : elapsed(timer, now);
    // A countdown rounds up, so it reads 0:00 only once it is over.
    const total = timer.mode === "countdown" ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A stored timer, or a fresh one when what is stored is not a timer. */
export function readTimer(raw: unknown, mode: TimerState["mode"], durationMs?: number): TimerState {
    const value = raw as Partial<TimerState> | null;
    if (
        value &&
        (value.mode === "countdown" || value.mode === "stopwatch") &&
        typeof value.durationMs === "number" &&
        typeof value.elapsedMs === "number" &&
        (value.startedAt === null || typeof value.startedAt === "number")
    ) {
        const kept: TimerState = {
            mode: value.mode,
            durationMs: clampDuration(value.durationMs),
            startedAt: value.startedAt,
            elapsedMs: Math.max(0, value.elapsedMs)
        };
        // A changed mode in the settings starts over in that mode.
        return kept.mode === mode ? kept : newTimer(mode, durationMs ?? kept.durationMs);
    }
    return newTimer(mode, durationMs);
}
