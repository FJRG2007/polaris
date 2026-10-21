/**
 * Polar's remembered choices in the browser's storage. A private window or
 * blocked storage reads as nothing remembered and writes as a no-op, so the
 * panel keeps working and only forgets.
 */

export type StoredArea = "local" | "session";

function area(which: StoredArea): Storage {
    return which === "session" ? window.sessionStorage : window.localStorage;
}

export function readStored(key: string, which: StoredArea = "local"): string | null {
    try {
        return area(which).getItem(key);
    } catch {
        return null;
    }
}

export function writeStored(key: string, value: string, which: StoredArea = "local"): void {
    try {
        area(which).setItem(key, value);
    } catch {
        // A private window: the panel works, it just forgets.
    }
}
