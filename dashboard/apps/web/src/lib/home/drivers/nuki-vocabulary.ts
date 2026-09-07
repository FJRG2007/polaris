/**
 * Nuki's numbers, in the words Places uses.
 *
 * Their device types, lock states, opener states and door sensor states, and
 * nothing else. Kept apart from either driver because there are two ways into the
 * same locks - their web account and a broker on the same network - and both are
 * handed the same enumerations by the same firmware. Two copies of this would
 * mean a lock that read as "open" one way and "unlatched" the other, which is the
 * sort of difference nobody notices until the door is the one that matters.
 *
 * Pure: no network, no credentials, no state. Everything here is a lookup, which
 * is why it can be checked without a lock.
 */

import type { DeviceKind, DeviceState, DoorState } from "@/lib/home/device-kinds";

/** Their device types: 0 Smart Lock, 2 Opener, 3 Smart Door, 4 Smart Lock 3.0/4th
 *  generation, 5 Smart Lock Ultra, Pro and Go. Type 1 is the Box, which is not a
 *  door and is left out rather than listed as a device that can do nothing. */
export function nukiKind(type: number): DeviceKind | null {
    if (type === 2) return "opener";
    if (type === 0 || type === 3 || type === 4 || type === 5) return "lock";
    return null;
}

const MODEL_NAMES: Readonly<Record<number, string>> = {
    0: "Smart Lock 2.0",
    2: "Opener",
    3: "Smart Door",
    4: "Smart Lock 4.0",
    5: "Smart Lock Ultra"
};

/** Type 5 ships as three products and the configuration says which. Where nothing
 *  says, the family name is the honest answer. */
const VARIANT_NAMES: Readonly<Record<number, string>> = {
    1: "Smart Lock Go",
    2: "Smart Lock Pro",
    3: "Smart Lock Ultra"
};

export function nukiModel(type: number, variant?: number): string {
    if (type === 5 && variant !== undefined && VARIANT_NAMES[variant]) return VARIANT_NAMES[variant];
    return MODEL_NAMES[type] ?? "Nuki device";
}

/** Their lock state, for types 0, 3, 4 and 5: 0 uncalibrated, 1 locked,
 *  2 unlocking, 3 unlocked, 4 locking, 5 unlatched, 6 unlocked (lock 'n' go),
 *  7 unlatching, 254 motor blocked, 255 undefined. */
export function nukiLockState(state: number | undefined): DeviceState {
    switch (state) {
        case 0:
            return "uncalibrated";
        case 1:
            return "locked";
        case 2:
        case 4:
        case 7:
            return "moving";
        case 3:
        case 6:
            return "unlocked";
        case 5:
            return "unlatched";
        case 254:
            return "jammed";
        default:
            return "unknown";
    }
}

/** Their opener state, which is a different enum on the same field: 0 untrained,
 *  1 online, 3 ring to open active, 5 open, 7 opening, 253 boot run. An opener at
 *  rest has no bolt to have thrown, so it reads as `locked` here and as "Idle" on
 *  a screen - see the kind-aware labels in `device-kinds`. */
export function nukiOpenerState(state: number | undefined): DeviceState {
    switch (state) {
        case 0:
            return "uncalibrated";
        case 1:
        case 3:
            return "locked";
        case 5:
            return "unlatched";
        case 7:
            return "moving";
        default:
            return "unknown";
    }
}

/** Their door sensor: 0 not paired, 1 deactivated, 2 closed, 3 opened, 4 unknown,
 *  5 calibrating, 16 uncalibrated, 240 removed or tampered, 255 unknown. No
 *  sensor and a sensor that cannot tell are different answers, and the screen
 *  says different things about them. */
export function nukiDoorState(state: number | undefined): DoorState {
    switch (state) {
        case 2:
            return "closed";
        case 3:
            return "open";
        case undefined:
        case 0:
        case 1:
        case 240:
            return "none";
        default:
            return "unknown";
    }
}

/** Their action numbers: 1 unlock, 2 lock, 3 unlatch, 4 lock 'n' go. The buttons
 *  a kind of device gets are decided once in `actionsFor`; this is the same rule
 *  at the edge, because what is on the other side of it is somebody's front door
 *  and a number sent in error is not a mistake worth being relaxed about. */
export const NUKI_ACTION_CODES = { unlock: 1, lock: 2, unlatch: 3, lockAndGo: 4 } as const;
