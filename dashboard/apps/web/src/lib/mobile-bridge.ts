/**
 * What the Polaris phone app adds to the page it hosts (`window.polarisMobile`,
 * `mobile/android/.../PageBridge.java`). Every method is optional: an older app
 * has fewer of them, and a browser has none.
 *
 * Client-only.
 */

interface PolarisMobileBridge {
    platform?(): string;
    version?(): string;
    /** "camera" or "gallery" for the file the last picker returned, else "". */
    lastPickSource?(): string;
    canViewOnce?(): boolean;
    openViewOnce?(attachmentId: string): void;
    /** Hand a web or mail address to the phone's browser or mail app. */
    openExternal?(url: string): void;
}

function bridge(): PolarisMobileBridge | null {
    if (typeof window === "undefined") return null;
    const found = (window as unknown as { polarisMobile?: PolarisMobileBridge }).polarisMobile;
    return found ?? null;
}

/** Whether this page runs inside the phone app. */
export function inPhoneApp(): boolean {
    return bridge() !== null;
}

/** Whether this app can open a view-once file. False in a browser and in an app too old to. */
export function canViewOnce(): boolean {
    try {
        return bridge()?.canViewOnce?.() === true;
    } catch {
        return false;
    }
}

/** Open a view-once file in the app's own protected screen. */
export function openViewOnce(attachmentId: string): boolean {
    const found = bridge();
    if (!found?.openViewOnce || !canViewOnce()) return false;
    found.openViewOnce(attachmentId);
    return true;
}

/**
 * Open an outside address in the phone's own browser or mail app. False in a
 * browser and in an app too old to, so the caller opens it the web's way.
 */
export function openExternal(url: string): boolean {
    const found = bridge();
    if (typeof found?.openExternal !== "function") return false;
    try {
        found.openExternal(url);
        return true;
    } catch {
        return false;
    }
}

/** Where the last picked file came from, when the app knows. */
export function lastPickSource(): "camera" | "gallery" | null {
    try {
        const source = bridge()?.lastPickSource?.();
        return source === "camera" || source === "gallery" ? source : null;
    } catch {
        return null;
    }
}
