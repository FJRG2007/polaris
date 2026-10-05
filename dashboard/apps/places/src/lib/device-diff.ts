/**
 * What changed between two reads of the same devices, and putting a change into
 * a list a screen already holds.
 *
 * The rule is Home Assistant's: an entity is only written again when its state
 * actually differs (`always_update=False` on a coordinator), and a screen only
 * redraws the entities a `subscribe_entities` frame names. When the device was
 * last read moves on every read, so it is kept apart from what the device is
 * doing - a sync that found everything as it was changes nothing on the screen
 * but the "updated" line.
 *
 * Client-safe: the devices screen loads it, and so does the server that pushes.
 */

import type { DeviceView } from "./device-kinds";
import type { DeviceAccountView } from "./device-accounts";

/** One push to an open devices screen. */
export interface DeviceChange {
    /** Devices that are new or whose state differs from the last push. */
    readonly devices: readonly DeviceView[];
    /** Devices that are gone, or that are no longer on this screen's place. */
    readonly removed: readonly string[];
    /** Every device a read just confirmed, changed or not, and when. */
    readonly seen: { readonly ids: readonly string[]; readonly at: string } | null;
    /** The connected accounts as they stand now, after a sync. Only ever sent to
     *  somebody who may see them. */
    readonly accounts?: readonly DeviceAccountView[];
}

/** Structural equality over the JSON-shaped values a device view holds. */
function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
        // A missing optional field and an explicit null mean the same thing on a
        // device: "this kind has none".
        return (a ?? null) === (b ?? null);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => same(value, b[index]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!same(left[key], right[key])) return false;
    return true;
}

/** Whether two reads of a device differ in anything but when they were taken. */
export function sameDevice(a: DeviceView, b: DeviceView): boolean {
    const { stateAt: _left, ...left } = a;
    const { stateAt: _right, ...right } = b;
    return same(left, right);
}

/** Whether two account lists say the same thing. */
export function sameAccounts(
    a: readonly DeviceAccountView[],
    b: readonly DeviceAccountView[]
): boolean {
    return same(a, b);
}

/**
 * A fresh full list, keeping every entry that did not change as the very object
 * the screen already holds - so a row given the same device does not redraw -
 * and the list itself when nothing changed at all.
 */
export function mergeDevices(
    current: readonly DeviceView[] | null,
    next: readonly DeviceView[],
    pushedSince: (id: string) => boolean = () => false
): DeviceView[] {
    if (!current) return [...next];
    const held = new Map(current.map((device) => [device.id, device]));
    // A device pushed after this read began is newer than the read: the read
    // must not put its old state back, and nothing would push it again until it
    // changed. What the screen holds of it wins - including its absence.
    const merged = next.flatMap((device) => {
        const before = held.get(device.id);
        if (pushedSince(device.id)) return before ? [before] : [];
        return [before && sameDevice(before, device) ? before : device];
    });
    const changed =
        merged.length !== current.length ||
        merged.some((device, index) => device !== current[index]);
    return changed ? merged : (current as DeviceView[]);
}

/**
 * A pushed change put into the list a screen holds.
 *
 * Changed devices replace their entries in place, so a row does not jump; a
 * device the screen has never seen is added at the end until the next full read
 * puts it in order. The list comes back as the same object when the push changed
 * nothing on it.
 */
export function applyDeviceChange(
    current: readonly DeviceView[] | null,
    change: Pick<DeviceChange, "devices" | "removed">
): DeviceView[] | null {
    if (!current) return null;
    const gone = new Set(change.removed);
    const incoming = new Map(change.devices.map((device) => [device.id, device]));
    let changed = false;
    const kept: DeviceView[] = [];
    for (const device of current) {
        if (gone.has(device.id)) {
            changed = true;
            continue;
        }
        const next = incoming.get(device.id);
        incoming.delete(device.id);
        if (next && !sameDevice(device, next)) {
            changed = true;
            kept.push(next);
        } else {
            kept.push(device);
        }
    }
    for (const device of incoming.values()) {
        if (gone.has(device.id)) continue;
        changed = true;
        kept.push(device);
    }
    return changed ? kept : (current as DeviceView[]);
}

/**
 * The devices of a push that differ from what was last pushed, remembering the
 * new ones as the last pushed. The server's half of the rule above: a sync that
 * found nothing new sends nothing but "seen".
 */
export function changedSince(
    known: Map<string, DeviceView>,
    read: readonly DeviceView[]
): DeviceView[] {
    const changed: DeviceView[] = [];
    for (const device of read) {
        const before = known.get(device.id);
        if (!before || !sameDevice(before, device)) changed.push(device);
        known.set(device.id, device);
    }
    return changed;
}
