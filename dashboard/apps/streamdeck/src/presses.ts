/**
 * Telling a press, a double press and a hold apart, from key down and key up.
 *
 * The Stream Deck SDK hands a plugin `keyDown` and `keyUp` and nothing else, so
 * the gestures are timed here, the way established plugins do it (SimHub's
 * Stream Deck plugin times its short and long keystrokes the same way):
 *
 * - With nothing but a press set, the press fires on key down: no added wait.
 * - With a hold set, a key held for `holdMs` fires the hold while still held;
 *   let go sooner, it is a press, fired on key up.
 * - With a double press set, a press waits `doubleMs` after key up for a
 *   second one. The second key down fires the double press at once.
 *
 * Pure but for the timers it is handed, so the tests drive it with fake ones.
 */

export type Gesture = "press" | "double" | "hold";

/** Which gestures a key has something set for. A press always has. */
export interface GestureSet {
    readonly double: boolean;
    readonly hold: boolean;
    readonly doubleMs: number;
    readonly holdMs: number;
}

export const DOUBLE_MS = 300;
export const HOLD_MS = 500;
/** What either window may be set to, in milliseconds. */
export const WINDOW_MIN_MS = 150;
export const WINDOW_MAX_MS = 2000;

/** A window as settings hold it, kept between the limits; the default for
 *  anything that is not a number. */
export function windowMs(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(WINDOW_MAX_MS, Math.max(WINDOW_MIN_MS, Math.round(value)));
}

type Timer = ReturnType<typeof setTimeout>;

interface Pending {
    /** Held right now. */
    down: boolean;
    /** The hold fired for this press, so letting go does nothing. */
    held: boolean;
    /** Waiting after a first press for a second. */
    waiting: boolean;
    holdTimer: Timer | null;
    doubleTimer: Timer | null;
    set: GestureSet;
}

export class PressTimer {
    readonly #keys = new Map<string, Pending>();

    constructor(private readonly fire: (key: string, gesture: Gesture) => void) {}

    down(key: string, set: GestureSet): void {
        const before = this.#keys.get(key);
        if (before?.waiting) {
            // The second press of a double: fired now, on the way down.
            this.#clear(before);
            this.#keys.set(key, { ...blank(set), down: true, held: true });
            this.fire(key, "double");
            return;
        }
        if (before) this.#clear(before);
        if (!set.double && !set.hold) {
            this.#keys.delete(key);
            this.fire(key, "press");
            return;
        }
        const pending: Pending = { ...blank(set), down: true };
        if (set.hold) {
            pending.holdTimer = setTimeout(() => {
                pending.holdTimer = null;
                pending.held = true;
                this.fire(key, "hold");
            }, set.holdMs);
        }
        this.#keys.set(key, pending);
    }

    up(key: string): void {
        const pending = this.#keys.get(key);
        if (!pending?.down) return;
        pending.down = false;
        if (pending.holdTimer) clearTimeout(pending.holdTimer);
        pending.holdTimer = null;
        if (pending.held) {
            this.#keys.delete(key);
            return;
        }
        if (!pending.set.double) {
            this.#keys.delete(key);
            this.fire(key, "press");
            return;
        }
        pending.waiting = true;
        pending.doubleTimer = setTimeout(() => {
            this.#keys.delete(key);
            this.fire(key, "press");
        }, pending.set.doubleMs);
    }

    /** A key that left the screen: whatever it was waiting for never fires. */
    forget(key: string): void {
        const pending = this.#keys.get(key);
        if (pending) this.#clear(pending);
        this.#keys.delete(key);
    }

    #clear(pending: Pending): void {
        if (pending.holdTimer) clearTimeout(pending.holdTimer);
        if (pending.doubleTimer) clearTimeout(pending.doubleTimer);
        pending.holdTimer = null;
        pending.doubleTimer = null;
    }
}

function blank(set: GestureSet): Pending {
    return { down: false, held: false, waiting: false, holdTimer: null, doubleTimer: null, set };
}

/** How long a key asking "again?" waits for the press that confirms it. */
export const CONFIRM_MS = 2000;

/**
 * The second press that confirms an action that cannot be undone. The first
 * press arms the key; another within `CONFIRM_MS` runs it, and after that the
 * key is disarmed again.
 */
export class Confirmations {
    readonly #armed = new Map<string, number>();

    /** True when this press runs the action; false when it only armed it. */
    press(key: string, now: number): boolean {
        const until = this.#armed.get(key);
        if (until !== undefined && now <= until) {
            this.#armed.delete(key);
            return true;
        }
        this.#armed.set(key, now + CONFIRM_MS);
        return false;
    }

    armed(key: string, now: number): boolean {
        const until = this.#armed.get(key);
        return until !== undefined && now <= until;
    }

    forget(key: string): void {
        this.#armed.delete(key);
    }
}
