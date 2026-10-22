/**
 * A press shows its result before Polaris answers, as Polaris's own screens do.
 *
 * A key flips, says "Locking" or shows the new temperature the moment it is
 * pressed, and the command goes out behind it. What Polaris answers then wins:
 * the state it returns replaces the guess, and a refusal or no answer at all
 * puts back the face the key had. A press whose result is already there - a
 * lock pressed to lock while locked - keeps its face; Polaris reads the device
 * again and does nothing.
 *
 * Shared with the Companion module. SDK-free and pure, so the tests reach it.
 */

import type { DeckAction, DeckState } from "./polaris";

/** What a press does to its key before Polaris answers. */
export type Prediction = { readonly noop: true } | { readonly face: DeckState } | null;

/**
 * What a press of `entry`'s key shows at once, from the state it shows now.
 * Polaris says it for the keys it knows (`state.press`); a toggle with nothing
 * said flips. Null when the key cannot know ahead: it waits for the answer.
 */
export function predict(
    entry: Pick<DeckAction, "kind"> | undefined,
    state: DeckState | undefined
): Prediction {
    if (!entry || !state) return null;
    if (state.press?.noop) return { noop: true };
    if (state.press?.face) return { face: state.press.face };
    if (entry.kind === "toggle" && typeof state.on === "boolean")
        return { face: { ...state, on: !state.on } };
    return null;
}

/**
 * The keys with a press on its way, and what each showed before it.
 *
 * While one is, a reading the stream brings for it is held rather than drawn -
 * it may be from before the command and would flick the key back - and is
 * what the key settles on if the press brings no state of its own.
 */
export class InFlight {
    readonly #before = new Map<string, DeckState | undefined>();
    readonly #late = new Map<string, DeckState>();

    /** A press is on its way; `before` is the face to put back. */
    begin(id: string, before: DeckState | undefined): void {
        if (!this.#before.has(id)) this.#before.set(id, before);
    }

    busy(id: string): boolean {
        return this.#before.has(id);
    }

    /** Hold a reading for a busy key. True when it was held, not to be drawn. */
    hold(id: string, state: DeckState): boolean {
        if (!this.#before.has(id)) return false;
        this.#late.set(id, state);
        return true;
    }

    /**
     * The press is over. What the key shows now: the state Polaris returned;
     * else, having worked, the newest reading or the guess (undefined: keep
     * it); else, refused or unanswered, the newest reading or the face it had.
     */
    settle(id: string, ok: boolean, returned?: DeckState): DeckState | undefined {
        const before = this.#before.get(id);
        const late = this.#late.get(id);
        this.#before.delete(id);
        this.#late.delete(id);
        if (returned) return returned;
        return ok ? late : (late ?? before);
    }

    forget(id: string): void {
        this.#before.delete(id);
        this.#late.delete(id);
    }
}

/**
 * A dial's turns, gathered into one command.
 *
 * Every tick moves the face; the level is sent once the dial has stopped for
 * `settleMs`, with the value it landed on. A burst that ends where it began
 * sends nothing, and a refused one goes back to where it began.
 */
export class DialBurst {
    readonly #start = new Map<string, number>();
    readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly settleMs: number,
        private readonly land: (id: string, from: number) => void
    ) {}

    /** A tick: `from` is the level before it, kept for the first of a burst. */
    turn(id: string, from: number): void {
        if (!this.#start.has(id)) this.#start.set(id, from);
        clearTimeout(this.#timers.get(id));
        this.#timers.set(
            id,
            setTimeout(() => {
                const start = this.#start.get(id);
                this.#timers.delete(id);
                this.#start.delete(id);
                if (start !== undefined) this.land(id, start);
            }, this.settleMs)
        );
    }

    /** Whether ticks are still coming in. */
    turning(id: string): boolean {
        return this.#timers.has(id);
    }

    forget(id: string): void {
        clearTimeout(this.#timers.get(id));
        this.#timers.delete(id);
        this.#start.delete(id);
    }
}
