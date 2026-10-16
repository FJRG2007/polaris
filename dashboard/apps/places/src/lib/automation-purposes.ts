/**
 * Blocks named for what they are for - "A door opens", "Is locked", "Movement
 * is seen" - rather than for how they are built. Each is an ordinary change
 * trigger or device condition, filled in for the device it is pointed at, so
 * nothing new is stored and the engine reads them as it reads any other; the
 * add dialog lists only the ones a device can answer.
 */

import * as kinds from "./device-kinds";
import * as auto from "./automation-kinds";
import type { DeviceView } from "./device-kinds";

export const TRIGGER_PURPOSES = [
    "opened",
    "closed",
    "locked",
    "unlocked",
    "motion",
    "still",
    "batteryLow",
    "unavailable"
] as const;
export type TriggerPurpose = (typeof TRIGGER_PURPOSES)[number];

export const CONDITION_PURPOSES = [
    "open",
    "shut",
    "isLocked",
    "isUnlocked",
    "moving",
    "quiet",
    "batteryIsLow",
    "isUnavailable"
] as const;
export type ConditionPurpose = (typeof CONDITION_PURPOSES)[number];

/** The prefix a purpose's value carries in the add dialog, beside the kinds. */
export const PURPOSE_PREFIX = "purpose:";

/** What a purpose watches on a device and the value it waits for, or null when
 *  that device cannot answer it. */
type Watch = { attribute: auto.AutomationAttribute; value: string };

/** The word a two-state sensor reads now, when it is one of `pair`. */
function sensorSays(device: DeviceView, pair: readonly [string, string]): boolean {
    if (kinds.deviceKind(device.kind) !== "sensor") return false;
    const value = device.reading?.value ?? "";
    return pair.includes(value);
}

/** Open or closed: a lock's door sensor, or a door or window sensor. */
function doorWatch(device: DeviceView, open: boolean): Watch | null {
    if (auto.attributesFor(device.kind).includes("door") && device.doorState !== "none")
        return { attribute: "door", value: open ? "open" : "closed" };
    if (sensorSays(device, auto.OPEN_PAIR))
        return { attribute: "reading", value: auto.OPEN_PAIR[open ? 0 : 1] };
    return null;
}

function lockWatch(device: DeviceView, locked: boolean): Watch | null {
    return kinds.deviceKind(device.kind) === "lock"
        ? { attribute: "state", value: locked ? "locked" : "unlocked" }
        : null;
}

function motionWatch(device: DeviceView, moving: boolean): Watch | null {
    return sensorSays(device, auto.MOTION_PAIR)
        ? { attribute: "reading", value: auto.MOTION_PAIR[moving ? 0 : 1] }
        : null;
}

/** A battery running low, on a device that reports one. */
function batteryWatch(device: DeviceView): Watch | null {
    return auto.hasBattery(device) ? { attribute: "battery", value: "low" } : null;
}

/** A device that stops answering. Every device can. */
function silentWatch(): Watch {
    return { attribute: "online", value: "offline" };
}

const TRIGGER_WATCH: Readonly<Record<TriggerPurpose, (device: DeviceView) => Watch | null>> = {
    opened: (device) => doorWatch(device, true),
    closed: (device) => doorWatch(device, false),
    locked: (device) => lockWatch(device, true),
    unlocked: (device) => lockWatch(device, false),
    motion: (device) => motionWatch(device, true),
    still: (device) => motionWatch(device, false),
    batteryLow: batteryWatch,
    unavailable: silentWatch
};

const CONDITION_WATCH: Readonly<Record<ConditionPurpose, (device: DeviceView) => Watch | null>> = {
    open: (device) => doorWatch(device, true),
    shut: (device) => doorWatch(device, false),
    isLocked: (device) => lockWatch(device, true),
    isUnlocked: (device) => lockWatch(device, false),
    moving: (device) => motionWatch(device, true),
    quiet: (device) => motionWatch(device, false),
    batteryIsLow: batteryWatch,
    isUnavailable: silentWatch
};

export function isTriggerPurpose(value: string): value is TriggerPurpose {
    return (TRIGGER_PURPOSES as readonly string[]).includes(value);
}

export function isConditionPurpose(value: string): value is ConditionPurpose {
    return (CONDITION_PURPOSES as readonly string[]).includes(value);
}

export function triggerFits(purpose: TriggerPurpose, device: DeviceView): boolean {
    return TRIGGER_WATCH[purpose](device) !== null;
}

export function conditionFits(purpose: ConditionPurpose, device: DeviceView): boolean {
    return CONDITION_WATCH[purpose](device) !== null;
}

/** The change trigger a purpose is, on `device`; null when the device cannot answer it. */
export function purposeTrigger(purpose: TriggerPurpose, device: DeviceView): auto.Trigger | null {
    const watch = TRIGGER_WATCH[purpose](device);
    if (!watch) return null;
    return {
        id: auto.nodeIdOf(),
        kind: "change",
        deviceId: device.id,
        attribute: watch.attribute,
        from: "",
        to: watch.value
    };
}

/** The device condition a purpose is, on `device`; null when the device cannot answer it. */
export function purposeCondition(
    purpose: ConditionPurpose,
    device: DeviceView
): auto.Condition | null {
    const watch = CONDITION_WATCH[purpose](device);
    if (!watch) return null;
    return {
        id: auto.nodeIdOf(),
        kind: "device",
        deviceId: device.id,
        attribute: watch.attribute,
        is: watch.value,
        negate: false
    };
}
