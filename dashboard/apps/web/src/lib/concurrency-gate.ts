/**
 * At most `max` of something at once, the rest waiting their turn.
 *
 * For work that is cheap to ask for and expensive to run many of together - the
 * server's outbound name lookups above all, which sit on a thread pool the whole
 * process shares (see `safe-fetch.ts`).
 */
export interface Gate {
    /** Run `task` once a place is free, and free it again when it settles. */
    run<T>(task: () => Promise<T>): Promise<T>;
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

    return {
        async run<T>(task: () => Promise<T>): Promise<T> {
            if (active < max) active += 1;
            else await new Promise<void>((resolve) => queue.push(resolve));
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
 */
export function createSharedFlight<T>(): (key: string, task: () => Promise<T>) => Promise<T> {
    const flying = new Map<string, Promise<T>>();
    return (key, task) => {
        const held = flying.get(key);
        if (held) return held;
        const started = task().finally(() => flying.delete(key));
        flying.set(key, started);
        return started;
    };
}
