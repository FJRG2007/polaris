/**
 * Getting back to the usual address on its own after it stopped answering.
 * Pure, with no `electron` import, so the rhythm is tested with fake timers.
 *
 * An update restarts the server, and a window that loaded during those seconds
 * landed on the worker's offline page or on the servers window with an error.
 * Neither may stay once the server answers again: the address is asked again
 * on a backoff, and at once when something suggests it may answer now (the
 * computer woke up, a window got focus). The first answer that is a Polaris
 * ends it.
 */

/** The waits between asks: quick at first, a restart takes seconds, then once a minute. */
export const RECONNECT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

/** How long to wait before ask number `attempt` (0-based). */
export function reconnectDelay(attempt: number): number {
    const index = Math.min(Math.max(0, Math.floor(attempt)), RECONNECT_DELAYS_MS.length - 1);
    return RECONNECT_DELAYS_MS[index]!;
}

/** The budget of one ask: longer than a typed address gets, a server coming up is slow. */
export const RECONNECT_PROBE_MS = 15_000;

export interface ReconnectOptions {
    /** Whether the address answers as a Polaris now. A throw counts as no. */
    readonly answers: () => Promise<boolean>;
    /** It answered: put the windows back on it. Called once per `start`. */
    readonly back: () => void;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

export interface Reconnector {
    /** Begin asking, if not already. */
    start(): void;
    /** Stop asking: it is back, or the server in use changed. */
    stop(): void;
    /** Ask now and start the backoff over - the network or the person is back. No-op while stopped. */
    nudge(): void;
    readonly active: boolean;
}

export function createReconnector(options: ReconnectOptions): Reconnector {
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let active = false;
    let attempt = 0;
    let timer: unknown = null;
    let asking = false;
    /** Bumped on every start and stop, so an answer that arrives late belongs to nobody. */
    let run = 0;

    const cancel = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
    };

    const schedule = () => {
        cancel();
        timer = setTimer(ask, reconnectDelay(attempt));
    };

    function ask(): void {
        timer = null;
        if (!active || asking) return;
        asking = true;
        const mine = run;
        void options
            .answers()
            .catch(() => false)
            .then((answered) => {
                if (mine !== run) return;
                asking = false;
                if (!active) return;
                if (answered) {
                    active = false;
                    cancel();
                    options.back();
                    return;
                }
                attempt += 1;
                schedule();
            });
    }

    return {
        start() {
            if (active) return;
            run += 1;
            active = true;
            asking = false;
            attempt = 0;
            schedule();
        },
        stop() {
            run += 1;
            active = false;
            asking = false;
            cancel();
        },
        nudge() {
            if (!active || asking) return;
            attempt = 0;
            cancel();
            ask();
        },
        get active() {
            return active;
        }
    };
}
