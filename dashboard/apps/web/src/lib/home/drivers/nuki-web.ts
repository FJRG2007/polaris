/**
 * Nuki over their web account, translated into the words Places uses.
 *
 * What is here is the account: the calls, their log, their triggers and their
 * failure codes. Their device types and states are in `nuki-vocabulary`, shared
 * with the local transport, because it is the same firmware answering either way
 * and two copies of an enumeration is a lock that reads differently depending on
 * how it was reached.
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
import * as vocabulary from "@/lib/home/drivers/nuki-vocabulary";
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

/** Only the actions a Nuki has, by the numbers in `nuki-vocabulary` - the same
 *  ones the local transport sends, because it is the same firmware answering. */
const ACTION_CODES: Readonly<Partial<Record<DeviceAction, number>>> = {
    lock: vocabulary.NUKI_ACTION_CODES.lock,
    unlock: vocabulary.NUKI_ACTION_CODES.unlock,
    unlatch: vocabulary.NUKI_ACTION_CODES.unlatch
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
            const kind = vocabulary.nukiKind(lock.type);
            // A Box is on the account and is not a door. Skipped rather than
            // listed as a device that can do nothing.
            if (!kind) continue;
            snapshots.push({
                externalId: String(lock.smartlockId),
                kind,
                name: lock.name.trim() || "Nuki device",
                model: vocabulary.nukiModel(lock.type, lock.config?.productVariant),
                firmware: nuki.nukiFirmware(lock.firmwareVersion),
                state:
                    kind === "opener"
                        ? vocabulary.nukiOpenerState(lock.state?.state)
                        : vocabulary.nukiLockState(lock.state?.state),
                doorState: vocabulary.nukiDoorState(lock.state?.doorState),
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
