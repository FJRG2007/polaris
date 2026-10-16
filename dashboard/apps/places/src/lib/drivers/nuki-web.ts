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

import { HomeError } from "../home-error";
import * as nuki from "../integrations/nuki-api";
import * as mqtt from "../integrations/nuki-mqtt";
import { toSnapshot as fromTopics } from "./nuki-local";
import * as vocabulary from "./nuki-vocabulary";
import type { DeviceAction } from "../device-kinds";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DeviceHistoryEntry,
    type DeviceSnapshot
} from "./contract";

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
// The local link
// ---------------------------------------------------------------------------

/**
 * The id a lock publishes under on a broker, from the one Nuki Web gives it.
 *
 * Web's `smartlockId` is the device type written in front of the Nuki ID, in
 * hex: 17988169541 is 0x4302DAF45, a type 4 lock whose Nuki ID - the one
 * printed on it, and the one its MQTT topics are named by - is 302DAF45. The
 * low 32 bits are the Nuki ID for every type, type 0 included.
 */
export function nukiIdOf(smartlockId: number | string): string {
    return (BigInt(smartlockId) & 0xffffffffn).toString(16).toUpperCase().padStart(8, "0");
}

/** The broker on this network the account's locks also publish to, when
 *  Polaris has linked one (`localHost` and the rest are written by Polaris
 *  itself, never typed). Null for an account that only has the cloud. */
export function localBrokerOf(credentials: Credentials): mqtt.NukiBroker | null {
    const host = credentials.localHost?.trim();
    if (!host) return null;
    const port = Number(credentials.localPort || 1883);
    return {
        host,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 1883,
        username: credentials.localUsername ?? "",
        password: credentials.localPassword ?? "",
        prefix: credentials.localPrefix?.trim() || "nuki"
    };
}

/** What the broker holds, by Nuki ID in upper case, or nothing when it cannot
 *  be read - the cloud reading stands on its own. */
async function brokerContents(
    broker: mqtt.NukiBroker | null
): Promise<Map<string, { readonly id: string; readonly topics: mqtt.DeviceTopics }>> {
    const byId = new Map<string, { readonly id: string; readonly topics: mqtt.DeviceTopics }>();
    if (!broker) return byId;
    try {
        for (const [id, topics] of await mqtt.readBroker(broker))
            byId.set(id.toUpperCase(), { id, topics });
    } catch {
        // A broker that is down leaves the cloud's answer as the answer.
    }
    return byId;
}

/** How long a press waits to see whether the lock is on the broker before it
 *  goes through the account instead. A broker on this network answers well
 *  inside it; one that is not there must not hold the door up. */
const ACT_READ_MS = 1500;

/** The broker's contents, or nothing if they take longer than `ms`. */
async function brokerContentsWithin(
    broker: mqtt.NukiBroker,
    ms: number
): Promise<Awaited<ReturnType<typeof brokerContents>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Awaited<ReturnType<typeof brokerContents>>>((resolve) => {
        timer = setTimeout(() => resolve(new Map()), ms);
    });
    try {
        return await Promise.race([brokerContents(broker), late]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The cloud's reading of a lock with the broker's laid over it.
 *
 * The broker is the lock speaking on this network a moment ago; the cloud is
 * what it last told Nuki's servers. Where the lock is on the broker, its state,
 * door and battery are taken from there. Name, model and whether it is online
 * stay the account's.
 */
export function overlay(
    snapshot: DeviceSnapshot,
    topics: mqtt.DeviceTopics | undefined
): DeviceSnapshot {
    if (!topics) return snapshot;
    const local = fromTopics(snapshot.externalId, topics);
    if (!local || !local.online) return snapshot;
    return {
        ...snapshot,
        state: local.state,
        doorState: local.doorState ?? snapshot.doorState,
        batteryPercent: local.batteryPercent ?? snapshot.batteryPercent,
        batteryCritical: local.batteryCritical
    };
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
    2: "it was canceled",
    3: "it had just been asked",
    4: "the lock was busy",
    5: "the battery is too low to turn the motor",
    6: "the clutch failed",
    7: "the motor lost power",
    8: "it did not finish",
    9: "the lock refused it",
    10: "night mode refused it",
    224: "the code was wrong",
    225: "the fingerprint was not recognized",
    226: "the tag was not recognized",
    254: "the lock reported an error",
    255: "the lock reported an error"
};

/** One entry of their log, as a row of ours. */
export function translateLog(entry: nuki.NukiLog): DeviceHistoryEntry {
    const at = new Date(entry.date);
    const failure =
        entry.state === 0 ? null : (LOG_FAILURES[entry.state] ?? "the lock reported an error");
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
        const [locks, local] = await Promise.all([
            speaking(() => nuki.listSmartlocks(token(credentials))),
            brokerContents(localBrokerOf(credentials))
        ]);
        const snapshots: DeviceSnapshot[] = [];
        for (const lock of locks) {
            const kind = vocabulary.nukiKind(lock.type);
            // A Box is on the account and is not a door. Skipped rather than
            // listed as a device that can do nothing.
            if (!kind) continue;
            const snapshot: DeviceSnapshot = {
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
            };
            snapshots.push(overlay(snapshot, local.get(nukiIdOf(lock.smartlockId))?.topics));
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
            externalIds.map((externalId) =>
                nuki.syncSmartlock(key, externalId).catch(() => undefined)
            )
        );
        // Their server answers the request before the lock has answered it. The
        // pause is the difference between reading the state somebody just asked
        // for and reading the one they already had on screen.
        await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
    },

    /**
     * Hear the locks change the moment they do, over the broker Polaris linked
     * on this network. Any message is a reason to read the account (`changed`
     * with no ids), which lays the broker's state over the cloud's. Refused
     * when there is no local link, and device-push asks again later.
     */
    async listen(credentials, changed, signal) {
        const broker = localBrokerOf(credentials);
        if (!broker) throw new DriverError("This Nuki account has no local link", "refused");
        try {
            await mqtt.watchBroker(broker, () => changed([]), signal);
        } catch (caught) {
            if (caught instanceof mqtt.NukiMqttError)
                throw new DriverError(caught.message, caught.kind);
            throw caught;
        }
    },

    /** Over the broker when the lock is on it - on this network, in
     *  milliseconds - and through the account otherwise, or when the broker
     *  could not take it. */
    async act(credentials, device, action) {
        const code = ACTION_CODES[action];
        if (code === undefined) throw new HomeError("A Nuki device cannot be told to do that");
        const broker = localBrokerOf(credentials);
        if (broker) {
            const held = (await brokerContentsWithin(broker, ACT_READ_MS)).get(
                nukiIdOf(device.externalId)
            );
            if (held && fromTopics(held.id, held.topics)?.online) {
                try {
                    // Under the id the lock itself publishes, in its own case.
                    await mqtt.sendAction(broker, held.id, code);
                    return;
                } catch {
                    // The account below is the way that is left.
                }
            }
        }
        await speaking(() => nuki.performAction(token(credentials), device.externalId, code));
    }
};
