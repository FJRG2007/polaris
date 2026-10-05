"use client";

/**
 * The devices screen as it was last seen, kept in this browser.
 *
 * Opening the screen draws this at once, and the read that follows only moves
 * what actually changed - so a screen nothing happened to since it was last
 * open does not visibly change at all. Kept per account and per place, so a
 * second person signing in on the same browser is never drawn somebody else's
 * doors, and a week is as long as it is kept: older than that, a blank frame
 * for half a second says less that is wrong.
 *
 * Wrapped in try/catch throughout: storage can be blocked, full or private, and
 * the screen has to work exactly as before without it.
 */

import type { DeviceView } from "../../lib/device-kinds";
import type { DeviceAccountView } from "../../lib/device-accounts";

const PREFIX = "polaris.places.devices.v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedDevices {
    readonly devices: DeviceView[];
    readonly accounts: DeviceAccountView[];
}

function hasIds(value: unknown): value is { id: string }[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { id?: unknown }).id === "string"
        )
    );
}

/** What was last seen under this key, or null. */
export function readCachedDevices(key: string): CachedDevices | null {
    try {
        const raw = window.localStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { at?: unknown; devices?: unknown; accounts?: unknown };
        if (typeof parsed.at !== "number" || Date.now() - parsed.at > MAX_AGE_MS) return null;
        if (!hasIds(parsed.devices) || !hasIds(parsed.accounts)) return null;
        return {
            devices: parsed.devices as unknown as DeviceView[],
            accounts: parsed.accounts as unknown as DeviceAccountView[]
        };
    } catch {
        return null;
    }
}

export function writeCachedDevices(key: string, value: CachedDevices): void {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), ...value }));
    } catch {
        // Full or blocked: the next open reads from the server, as it always did.
    }
}
