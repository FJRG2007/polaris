/**
 * Telling open devices screens that a device changed.
 *
 * The same in-process bus Chat and Tasks use, for the same reason: every sync
 * and every press happens in this server, so there is nothing for a broker to
 * carry between. If Polaris ever runs replicas this grows a transport with those
 * two, and nothing above it changes.
 *
 * Unlike Chat, a frame carries the device itself rather than an id to pull: a
 * device view holds nothing a screen that lists it is not already shown, and
 * the stream filters each frame by what its reader reaches and by the place it
 * is looking at before anything is written. See `routes/api/home/devices/live`.
 *
 * What is published is only what changed since the last publish: every sync
 * reads every device, and most of them are as they were.
 *
 * Server-only.
 */

import type { DeviceView } from "./device-kinds";
import type { PlacesReach } from "./sharing";
import type { DeviceAccountView } from "./device-accounts";
import { changedSince, type DeviceChange } from "./device-diff";

/** A change, and which install it is about. */
export interface InstallDeviceChange extends DeviceChange {
    readonly installedAppId: string;
}

type Listener = (change: InstallDeviceChange) => void;

/**
 * Held on globalThis rather than in a module binding. A dev server re-evaluates
 * a module on edit, and a fresh module-scoped Set would strand every connection
 * opened against the previous copy.
 */
const REGISTRY = Symbol.for("polaris.places.devices.live");

interface Registry {
    listeners: Set<Listener>;
    /** What was last published of each device, per install. */
    known: Map<string, Map<string, DeviceView>>;
}

function registry(): Registry {
    const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
    holder[REGISTRY] ??= { listeners: new Set(), known: new Map() };
    return holder[REGISTRY];
}

/** Whether any screen is listening. Lets a sync skip the work of a publish
 *  nobody would receive. */
export function hasListeners(): boolean {
    return registry().listeners.size > 0;
}

export function subscribeDeviceChanges(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function publish(change: InstallDeviceChange): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (error) {
            console.error("places: a devices stream could not take a change:", error);
        }
    }
}

/**
 * What a read or a press just found, and what is gone.
 *
 * Remembered whether or not anybody is listening, so the first screen to open
 * after a quiet hour is not sent every device as news.
 */
export function announceDevices(
    installedAppId: string,
    read: readonly DeviceView[],
    removed: readonly string[] = []
): void {
    const { known } = registry();
    let held = known.get(installedAppId);
    if (!held) {
        held = new Map();
        known.set(installedAppId, held);
    }
    for (const id of removed) held.delete(id);
    const devices = changedSince(held, read);
    if (!hasListeners()) return;
    if (read.length === 0 && removed.length === 0) return;
    publish({
        installedAppId,
        devices,
        removed,
        seen: read.length
            ? { ids: read.map((device) => device.id), at: new Date().toISOString() }
            : null
    });
}

/** The accounts as they stand after a sync: when each was last read, and
 *  which of them is refusing. */
export function announceAccounts(
    installedAppId: string,
    accounts: readonly DeviceAccountView[]
): void {
    if (!hasListeners()) return;
    publish({ installedAppId, devices: [], removed: [], seen: null, accounts });
}

/**
 * One change as this reader may be sent it, or null when none of it is theirs.
 *
 * Pure apart from its inputs, so the filtering can be asserted on its own.
 */
export function frameFor(
    change: DeviceChange,
    reach: PlacesReach,
    placeId: string
): DeviceChange | null {
    const reaches = (id: string) => reach.everything || reach.devices.has(id);
    const here = (devicePlace: string | null) => devicePlace === null || devicePlace === placeId;
    const devices = change.devices.filter((device) => reaches(device.id) && here(device.placeId));
    const removed = [
        ...change.removed.filter(reaches),
        // Moved to another place: off this screen, said by id alone.
        ...change.devices
            .filter((device) => reaches(device.id) && !here(device.placeId))
            .map((device) => device.id)
    ];
    const seenIds = change.seen?.ids.filter(reaches) ?? [];
    const accounts = reach.everything ? change.accounts : undefined;
    if (devices.length === 0 && removed.length === 0 && seenIds.length === 0 && !accounts) {
        return null;
    }
    return {
        devices,
        removed,
        seen: change.seen && seenIds.length ? { ids: seenIds, at: change.seen.at } : null,
        ...(accounts ? { accounts } : {})
    };
}
