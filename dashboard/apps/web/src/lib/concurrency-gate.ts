/**
 * At most `max` of something at once, the rest waiting their turn.
 *
 * For work that is cheap to ask for and expensive to run many of together - the
 * server's outbound name lookups above all, which sit on a thread pool the whole
 * process shares (see `safe-fetch.ts`).
 */
export interface Gate {
    /**
     * Run `task` once a place is free, and free it again when it settles.
     *
     * A `signal` that aborts while the task is still waiting takes it out of the
     * line and rejects with the signal's reason; once started, it runs to the end.
     */
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    /** How many are running right now. */
    readonly active: number;
    /** How many are waiting for a place. */
    readonly waiting: number;
}

export function createGate(max: number): Gate {
    if (!Number.isInteger(max) || max < 1) throw new Error("A gate needs at least one place.");
    let active = 0;
    const queue: Array<() => void> = [];

    const release = (): void => {
        const next = queue.shift();
        // Handed straight to the next in line, so the count never dips and lets
        // a newcomer jump the queue.
        if (next) next();
        else active -= 1;
    };

    const place = (signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted) return Promise.reject(abortReason(signal));
        if (active < max) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const leave = (): void => {
                const at = queue.indexOf(enter);
                if (at >= 0) queue.splice(at, 1);
                reject(abortReason(signal!));
            };
            const enter = (): void => {
                signal?.removeEventListener("abort", leave);
                resolve();
            };
            queue.push(enter);
            signal?.addEventListener("abort", leave, { once: true });
        });
    };

    return {
        async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
            await place(signal);
            try {
                return await task();
            } finally {
                release();
            }
        },
        get active() {
            return active;
        },
        get waiting() {
            return queue.length;
        }
    };
}

/**
 * One run per key at a time: a second ask for the same key while the first is
 * still out gets the first one's answer instead of starting its own.
 *
 * A caller that passes a `signal` stops waiting when it aborts. Once every
 * caller of a run has stopped waiting, the run's own signal aborts - so a task
 * still queued behind a gate is dropped rather than done for nobody - and the
 * next ask for that key starts afresh.
 */
export function createSharedFlight<T>(): (
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
) => Promise<T> {
    interface Flight {
        readonly answer: Promise<T>;
        readonly abandon: AbortController;
        waiters: number;
    }
    const flying = new Map<string, Flight>();

    return (key, task, signal) => {
        if (signal?.aborted) return Promise.reject(abortReason(signal));
        let flight = flying.get(key);
        if (!flight) {
            const abandon = new AbortController();
            const answer = (async () => task(abandon.signal))().finally(() => {
                if (flying.get(key) === created) flying.delete(key);
            });
            const created: Flight = { answer, abandon, waiters: 0 };
            flying.set(key, created);
            flight = created;
        }
        flight.waiters += 1;
        if (!signal) return flight.answer;

        const mine = flight;
        return new Promise<T>((resolve, reject) => {
            const leave = (): void => {
                reject(abortReason(signal));
                mine.waiters -= 1;
                if (mine.waiters > 0) return;
                if (flying.get(key) === mine) flying.delete(key);
                mine.abandon.abort(abortReason(signal));
            };
            signal.addEventListener("abort", leave, { once: true });
            mine.answer
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", leave));
        });
    };
}

/** A signal that aborts after `ms` with `message` as its reason, or when `also`
 *  does. `clear` stops the clock once the wait is over. */
export function deadline(
    ms: number,
    message: string,
    also?: AbortSignal
): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(message)), ms);
    const follow = (): void => controller.abort(abortReason(also!));
    if (also?.aborted) follow();
    else also?.addEventListener("abort", follow, { once: true });
    return {
        signal: controller.signal,
        clear: () => {
            clearTimeout(timer);
            also?.removeEventListener("abort", follow);
        }
    };
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("The wait was abandoned.");
}
