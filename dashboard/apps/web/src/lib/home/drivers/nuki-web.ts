/**
 * Nuki over their web account, translated into the words Places uses.
 *
 * This is the whole of what Polaris knows about Nuki's numbering: their device
 * types, their lock states, their door states, their log actions, their triggers
 * and their failure codes. Everything above it speaks `device-kinds` and would
 * not have to change for a second make of lock.
 *
 * One account is how Nuki is actually used: ten doors across three offices are
 * ten devices on one login. Somebody with two accounts connects two, and the
 * driver is the same both times - it is handed the credentials rather than
 * fetching them, which is what makes that true.
 *
 * Server-only.
 */

import { HomeError } from "@/lib/home/home-error";
import * as nuki from "@/lib/integrations/nuki-api";
import type { DeviceAction } from "@/lib/home/device-kinds";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DeviceHistoryEntry,
    type DeviceSnapshot
} from "@/lib/home/drivers/contract";

export const NUKI_WEB = "nuki-web";

/** How much of the account's log one sync reads. Nuki answers newest first, and a
 *  place with a few doors does not turn over two hundred entries between syncs -
 *  the ones already written are skipped, so re-reading the overlap costs nothing
 *  and is what makes a missed sync heal itself. */
const LOG_PAGE = 200;

/**
 * Their refusal, as one this app can act on.
 *
 * A `NukiError` is already written for a person - "the motor was blocked", "the
 * token may have been revoked" - and names no host, path or credential, so the
 * sentence passes through. What it carries that matters as much is which sort of
 * wrong it was, and that is kept rather than flattened.
 */
async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof nuki.NukiError) {
            throw new DriverError(
                caught.message,
                caught.kind === "unauthorized"
                    ? "unauthorized"
                    : caught.kind === "unreachable"
                      ? "unreachable"
                      : "refused"
            );
        }
        throw caught;
    }
}

function token(credentials: Credentials): string {
    const value = credentials.token;
    if (!value) throw new HomeError("That connection is missing its token");
    return value;
}

// ---------------------------------------------------------------------------
// Their numbers, in our words
// ---------------------------------------------------------------------------

/** Nuki's device types: 0 Smart Lock 1/2, 2 Opener, 3 Smart Door, 4 Smart Lock
 *  3/4, 5 Smart Lock 5. Type 1 is the Box, which is not a door. */
function kindOf(type: number): "lock" | "opener" | null {
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

/** Smart Lock 5 ships as three products and the config says which. */
const VARIANT_NAMES: Readonly<Record<number, string>> = {
    1: "Smart Lock Go",
    2: "Smart Lock Pro",
    3: "Smart Lock Ultra"
};

function modelOf(lock: nuki.NukiSmartlock): string {
    if (lock.type === 5) {
        const variant = lock.config?.productVariant;
        if (variant !== undefined && VARIANT_NAMES[variant]) return VARIANT_NAMES[variant];
    }
    return MODEL_NAMES[lock.type] ?? "Nuki device";
}

/** Their lock state, for their types 0, 3, 4 and 5. */
function stateOfLock(state: number | undefined): DeviceSnapshot["state"] {
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
function stateOfOpener(state: number | undefined): DeviceSnapshot["state"] {
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
 *  5 calibrating, 16 uncalibrated, 240 removed, 255 unknown. */
function doorOf(state: number | undefined): DeviceSnapshot["doorState"] {
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

/** Their log actions. Anything not named here is real but not worth a sentence of
 *  its own - a firmware update, the log being switched on - and lands as `other`
 *  rather than being dropped, because a gap in a door's history is worse than a
 *  vague line in it. */
const LOG_ACTIONS: Readonly<Record<number, string>> = {
    1: "unlock",
    2: "lock",
    3: "unlatch",
    4: "lock-and-go",
    5: "lock-and-go",
    208: "door-ajar",
    240: "door-opened",
    241: "door-closed",
    253: "calibrated"
};

/** Their triggers: 0 system, 1 manual, 2 button, 3 automatic, 4 web, 5 app,
 *  6 auto lock, 7 accessory, 253 keypad error, 254 nuki mode, 255 keypad. */
const LOG_VIA: Readonly<Record<number, string>> = {
    0: "system",
    1: "manual",
    2: "button",
    3: "auto",
    4: "app",
    5: "app",
    6: "auto",
    7: "fob",
    253: "keypad",
    254: "app",
    255: "keypad"
};

/** Their completion states. 0 is success; the rest are why a door did not move,
 *  and they are the reason anybody opens the history. */
const LOG_FAILURES: Readonly<Record<number, string>> = {
    1: "the motor was blocked",
    2: "it was cancelled",
    3: "it had just been asked",
    4: "the lock was busy",
    5: "the battery is too low to turn the motor",
    6: "the clutch failed",
    7: "the motor lost power",
    8: "it did not finish",
    9: "the lock refused it",
    10: "night mode refused it",
    224: "the code was wrong",
    225: "the fingerprint was not recognised",
    226: "the tag was not recognised",
    254: "the lock reported an error",
    255: "the lock reported an error"
};

/** One entry of their log, as a row of ours. */
export function translateLog(entry: nuki.NukiLog): DeviceHistoryEntry {
    const at = new Date(entry.date);
    const failure = entry.state === 0 ? null : (LOG_FAILURES[entry.state] ?? "the lock reported an error");
    return {
        externalId: entry.id,
        deviceExternalId: entry.smartlockId === undefined ? "" : String(entry.smartlockId),
        action: LOG_ACTIONS[entry.action] ?? "other",
        // Their `name` is whoever or whatever did it. Blank on the entries nobody
        // did - a door closing is not somebody's doing.
        actor: entry.name?.trim() || null,
        via: entry.autoUnlock ? "auto" : (LOG_VIA[entry.trigger] ?? "system"),
        outcome: failure === null ? "ok" : "failed",
        note: failure,
        at: Number.isNaN(at.getTime()) ? new Date() : at
    };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Nuki's action numbers, and only the actions a Nuki has. The buttons a kind of
 *  device gets are decided once in `actionsFor`; this is the same rule said again
 *  at the edge, because what is on the other side of it is somebody's front door
 *  and a number sent in error is not a mistake worth being relaxed about. */
const ACTION_CODES: Readonly<Partial<Record<DeviceAction, number>>> = {
    lock: nuki.NUKI_ACTIONS.lock,
    unlock: nuki.NUKI_ACTIONS.unlock,
    unlatch: nuki.NUKI_ACTIONS.unlatch
};

/** How long a lock is given to answer after being asked to report, before it is
 *  read. Long enough for a lock that is awake, short enough that somebody who
 *  pressed a button is not left watching a spinner - and the read after this one
 *  catches whatever was still on its way. */
const PROBE_SETTLE_MS = 2500;

export const nukiWebDriver: DeviceDriver = {
    connection: NUKI_WEB,

    /**
     * Whether the token works, and what it can see.
     *
     * The list is the check: Nuki has no endpoint for verifying one, and asking
     * for the devices is what the connection is for anyway.
     */
    async verify(credentials) {
        await speaking(() => nuki.listSmartlocks(token(credentials)));
    },

    async list(credentials) {
        const locks = await speaking(() => nuki.listSmartlocks(token(credentials)));
        const snapshots: DeviceSnapshot[] = [];
        for (const lock of locks) {
            const kind = kindOf(lock.type);
            // A Box is on the account and is not a door. Skipped rather than
            // listed as a device that can do nothing.
            if (!kind) continue;
            snapshots.push({
                externalId: String(lock.smartlockId),
                kind,
                name: lock.name.trim() || "Nuki device",
                model: modelOf(lock),
                firmware: nuki.nukiFirmware(lock.firmwareVersion),
                state: kind === "opener" ? stateOfOpener(lock.state?.state) : stateOfLock(lock.state?.state),
                doorState: doorOf(lock.state?.doorState),
                batteryPercent: lock.state?.batteryCharge ?? null,
                batteryCritical: lock.state?.batteryCritical ?? false,
                // Their `serverState` 4 is a device they cannot reach either.
                // Anything else is a device that answered, whatever it answered.
                online: (lock.serverState ?? 0) !== 4
            });
        }
        return snapshots;
    },

    /** The whole account's log in one call rather than one per lock: a place with
     *  six doors is one request instead of six, and what Nuki rate limits is the
     *  account. Entries belonging to nothing we hold are dropped by the caller. */
    async history(credentials, limit) {
        const entries = await speaking(() => nuki.listLogs(token(credentials), limit || LOG_PAGE));
        return entries.map(translateLog);
    },

    async probe(credentials, externalIds) {
        const key = token(credentials);
        // A lock that will not wake is still a lock whose last known state is
        // worth showing, so a refusal here is not allowed to fail the read that
        // follows it.
        await Promise.all(
            externalIds.map((externalId) => nuki.syncSmartlock(key, externalId).catch(() => undefined))
        );
        // Their server answers the request before the lock has answered it. The
        // pause is the difference between reading the state somebody just asked
        // for and reading the one they already had on screen.
        await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
    },

    async act(credentials, device, action) {
        const code = ACTION_CODES[action];
        if (code === undefined) throw new HomeError("A Nuki device cannot be told to do that");
        await speaking(() => nuki.performAction(token(credentials), device.externalId, code));
    }
};
