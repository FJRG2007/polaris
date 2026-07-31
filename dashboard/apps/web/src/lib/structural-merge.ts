/**
 * Fold a fresh snapshot into the one already on screen, keeping the previous
 * object for every part that did not actually change.
 *
 * A device polled every few seconds reports almost the same thing every time: a
 * NAS whose CPU moved a point still has the same seven drive bays, the same
 * pool, the same firmware. Replacing the whole object would hand React a new
 * reference for all of it and re-render the lot, which is what makes a live
 * panel flicker and what makes memoizing children pointless.
 *
 * So this walks both values and returns `previous` itself wherever the two are
 * equal, and otherwise a new container whose unchanged children are still the
 * previous references. The result is `next` in value and mostly `previous` in
 * identity - only what differs is new.
 */

/** Whether a value is a plain object worth walking into (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The merged value. Returns `previous` when nothing under it changed, so a
 * caller can compare by reference to know whether to re-render at all.
 */
export function mergeUnchanged<T>(previous: T, next: T): T {
    if (Object.is(previous, next)) return previous;

    if (Array.isArray(previous) && Array.isArray(next)) {
        if (previous.length !== next.length) {
            // A different length is a different list; still reuse the entries that
            // line up, so a NAS gaining a disk does not re-render the other six.
            const grown = next.map((entry, index) =>
                index < previous.length ? mergeUnchanged(previous[index], entry) : entry
            );
            return grown as unknown as T;
        }
        let same = true;
        const merged = next.map((entry, index) => {
            const value = mergeUnchanged(previous[index], entry);
            if (!Object.is(value, previous[index])) same = false;
            return value;
        });
        return (same ? previous : merged) as unknown as T;
    }

    if (isRecord(previous) && isRecord(next)) {
        const keys = Object.keys(next);
        // A removed key is a real change even if every surviving value matches.
        let same = keys.length === Object.keys(previous).length;
        const merged: Record<string, unknown> = {};
        for (const key of keys) {
            const value = mergeUnchanged(previous[key], next[key]);
            if (!Object.is(value, previous[key])) same = false;
            merged[key] = value;
        }
        return (same ? previous : merged) as T;
    }

    return next;
}
