/**
 * Timing helpers for work that reaches something outside this process.
 *
 * Anything that talks to a NAS, a remote host or a container can hang rather
 * than fail - a share that stopped answering keeps a promise pending forever -
 * so the callers that a person is waiting on put a bound on it instead of
 * leaving a screen loading with nothing to show.
 */

/** Reject with a clear message if a promise does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(reason)), ms);
        if (typeof timer.unref === "function") timer.unref();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
