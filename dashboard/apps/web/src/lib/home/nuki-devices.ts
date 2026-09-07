/**
 * Nuki, translated into the words Places uses.
 *
 * This is the whole of what Polaris knows about Nuki: their state numbers, their
 * trigger numbers, and how to turn an account's worth of them into device rows
 * and history. Everything above it - the service, the actions, the screens -
 * speaks `device-kinds` and would not have to change for a second make of lock.
 *
 * One connection per install, held in `Setting` and envelope-encrypted. One
 * account is how Nuki is actually used: ten doors across three offices are ten
 * devices on one login, and a token per door would be ten secrets to rotate for
 * no gain. If a deployment ever needs two accounts this is the file that grows a
 * table; nothing else moves.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { HomeError } from "@/lib/home/home-error";
import { DEVICE_ACTION_VERBS, type DeviceAction } from "@/lib/home/device-kinds";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    NUKI_ACTIONS,
    NukiError,
    listLogs,
    listSmartlocks,
    nukiFirmware,
    performAction,
    syncSmartlock,
    type NukiLog,
    type NukiSmartlock
} from "@/lib/integrations/nuki-api";

export const NUKI_VENDOR = "nuki";

/**
 * Their refusal, as one this app is willing to show.
 *
 * A `NukiError` is already written for a person - "the motor was blocked", "the
 * token may have been revoked" - and naming no host, path or credential, so it
 * passes through as the sentence the screen puts up. Anything else is a fault and
 * is left alone to be logged as one.
 */
async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof NukiError) throw new HomeError(caught.message);
        throw caught;
    }
}

const KEYS = {
    token: "places.nuki.token",
    label: "places.nuki.label",
    syncedAt: "places.nuki.syncedAt",
    status: "places.nuki.status"
} as const;

/** How much of the account's log one sync reads. Nuki answers newest first, and a
 *  place with a few doors does not turn over two hundred entries between syncs -
 *  the ones already written are skipped, so re-reading the overlap costs nothing
 *  and is what makes a missed sync heal itself. */
const LOG_PAGE = 200;

/** How long a lock is given to answer after being asked to report, before it is
 *  read. Long enough for a lock that is awake, short enough that somebody who
 *  pressed a button is not left watching a spinner - and the read after this one
 *  catches whatever was still on its way. */
const PROBE_SETTLE_MS = 2500;

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

async function readSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

async function writeSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}

/** The token, or null when nobody has connected an account. */
export async function nukiToken(): Promise<string | null> {
    const raw = await readSetting(KEYS.token);
    if (!raw) return null;
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        // A master key that has changed under a stored credential. Nothing here
        // can recover it, and a connection that cannot be read is a connection
        // that has to be made again.
        return null;
    }
}

/** How the connection stands, for the screen that offers to make or break it.
 *  Never the token, and never a fragment of it. */
export interface NukiConnection {
    readonly connected: boolean;
    /** What to call the account, which is what somebody typed when connecting. */
    readonly label: string;
    /** ok | unauthorized - whether the last call was refused. A refused token is
     *  still stored: taking it away on one bad answer would silently disconnect a
     *  house over a network blip, and this way the screen can say so and offer
     *  the one button that fixes it. */
    readonly status: string;
    readonly lastSyncedAt: string | null;
}

export async function nukiConnection(): Promise<NukiConnection> {
    const [token, label, status, syncedAt] = await Promise.all([
        readSetting(KEYS.token),
        readSetting(KEYS.label),
        readSetting(KEYS.status),
        readSetting(KEYS.syncedAt)
    ]);
    return {
        connected: token !== null,
        label: label ?? "",
        status: status ?? "ok",
        lastSyncedAt: syncedAt
    };
}

/**
 * Connect an account, having proved the token works first.
 *
 * Verified before it is stored rather than after: a token that is refused must
 * never become the connection, or the next screen shows a house with no doors and
 * no reason given. What proves it is asking for the devices, which is the call
 * everything else here makes anyway.
 */
export async function connectNuki(token: string, label: string): Promise<{ devices: number }> {
    const found = await speaking(() => listSmartlocks(token));
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    await writeSetting(
        KEYS.token,
        JSON.stringify({
            c: blob.ciphertext.toString("base64"),
            n: blob.nonce.toString("base64"),
            k: blob.keyId
        })
    );
    await writeSetting(KEYS.label, label.trim() || "Nuki");
    await writeSetting(KEYS.status, "ok");
    return { devices: found.length };
}

/**
 * Take the account away.
 *
 * The devices go with it, and their history with them. That is the honest
 * behaviour rather than the convenient one: a row nothing can reach is a lock
 * somebody would still press, and keeping months of who-opened-what for an
 * account that has been disconnected is keeping a record of a building Polaris
 * has just been told it has no business with.
 */
export async function disconnectNuki(installedAppId: string): Promise<void> {
    await prisma.placeDevice.deleteMany({ where: { installedAppId, vendor: NUKI_VENDOR } });
    for (const key of Object.values(KEYS)) await writeSetting(key, null);
}

/** The token, refusing rather than answering when there is none. */
async function requireToken(): Promise<string> {
    const token = await nukiToken();
    if (!token) throw new HomeError("No Nuki account is connected");
    return token;
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

function modelOf(lock: NukiSmartlock): string {
    if (lock.type === 5) {
        const variant = lock.config?.productVariant;
        if (variant !== undefined && VARIANT_NAMES[variant]) return VARIANT_NAMES[variant];
    }
    return MODEL_NAMES[lock.type] ?? "Nuki device";
}

/** Their lock state, for their types 0, 3, 4 and 5. */
function stateOfLock(state: number | undefined): string {
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
 *  rest is not "locked" - there is no bolt - so it reads as locked only in the
 *  sense the screen needs, which is "nothing is being let through". */
function stateOfOpener(state: number | undefined): string {
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
function doorOf(state: number | undefined): string {
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
export function translateLog(entry: NukiLog): {
    externalId: string;
    action: string;
    actor: string | null;
    via: string;
    outcome: string;
    note: string | null;
    at: Date;
} {
    const at = new Date(entry.date);
    const failure = entry.state === 0 ? null : (LOG_FAILURES[entry.state] ?? "the lock reported an error");
    return {
        externalId: entry.id,
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
// Syncing
// ---------------------------------------------------------------------------

/**
 * Bring the account's devices and their recent history up to date.
 *
 * Two calls for the whole account, whatever it holds: one list of devices and one
 * page of log. A device that has gone from the account is taken off here too - a
 * lock somebody sold is not a lock this house has, and leaving the row would
 * leave a button that answers with an error nobody can act on.
 *
 * Returns how many devices the account has, so a screen that asked for a sync can
 * say what came of it.
 */
export async function syncNuki(
    installedAppId: string,
    options: { probe?: boolean } = {}
): Promise<{ devices: number }> {
    const token = await requireToken();
    // Somebody pressed "check again", so the locks are asked to say where they
    // are before they are read. Only then: waking a lock over its radio is what
    // empties its battery, and a timer doing it would flatten a door in a month.
    // Failures are swallowed rather than raised - a lock that will not wake is
    // still a lock whose last known state is worth showing.
    if (options.probe) {
        const known = await prisma.placeDevice.findMany({
            where: { installedAppId, vendor: NUKI_VENDOR },
            select: { externalId: true }
        });
        await Promise.all(
            known.map((device) => syncSmartlock(token, device.externalId).catch(() => undefined))
        );
        // Their server answers the request before the lock has answered it. A
        // pause here is the difference between reading the state somebody just
        // asked for and reading the one they already had on screen.
        await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
    }
    let locks: NukiSmartlock[];
    try {
        locks = await listSmartlocks(token);
    } catch (caught) {
        // A refused token is remembered rather than acted on: the screen says so
        // and offers the one button that fixes it, instead of a house quietly
        // losing its doors to one bad answer.
        if (caught instanceof NukiError && caught.kind === "unauthorized") {
            await writeSetting(KEYS.status, "unauthorized");
        }
        if (caught instanceof NukiError) throw new HomeError(caught.message);
        throw caught;
    }
    await writeSetting(KEYS.status, "ok");

    const seen: string[] = [];
    for (const lock of locks) {
        const kind = kindOf(lock.type);
        // A Box is on the account and is not a door. Skipped rather than listed
        // as a device that can do nothing.
        if (!kind) continue;
        const externalId = String(lock.smartlockId);
        seen.push(externalId);
        const fields = {
            installedAppId,
            kind,
            name: lock.name.trim() || "Nuki device",
            model: modelOf(lock),
            firmware: nukiFirmware(lock.firmwareVersion),
            state: kind === "opener" ? stateOfOpener(lock.state?.state) : stateOfLock(lock.state?.state),
            doorState: doorOf(lock.state?.doorState),
            batteryPercent: lock.state?.batteryCharge ?? null,
            batteryCritical: lock.state?.batteryCritical ?? false,
            // Their `serverState` 4 is a device they cannot reach either. Anything
            // else is a device that answered, whatever it answered.
            online: (lock.serverState ?? 0) !== 4,
            stateAt: new Date()
        };
        await prisma.placeDevice.upsert({
            where: { vendor_externalId: { vendor: NUKI_VENDOR, externalId } },
            // The name, the place and the zone are not overwritten on the way in:
            // a door renamed here is renamed for a reason, and a sync that put
            // "Smart Lock 4" back over "Warehouse side door" every minute would
            // make the field pointless.
            update: {
                model: fields.model,
                firmware: fields.firmware,
                state: fields.state,
                doorState: fields.doorState,
                batteryPercent: fields.batteryPercent,
                batteryCritical: fields.batteryCritical,
                online: fields.online,
                stateAt: fields.stateAt
            },
            create: { ...fields, vendor: NUKI_VENDOR, externalId }
        });
    }

    // Anything on our side the account no longer has.
    await prisma.placeDevice.deleteMany({
        where: { installedAppId, vendor: NUKI_VENDOR, externalId: { notIn: seen } }
    });

    await speaking(() => ingestLogs(token, installedAppId));
    await writeSetting(KEYS.syncedAt, new Date().toISOString());
    return { devices: seen.length };
}

/**
 * Their log, written down as ours.
 *
 * `createMany` with `skipDuplicates` rather than a read-then-write: the unique
 * key on (device, their id) is what decides, so two syncs racing each other write
 * the same history once and neither has to hold a lock to be sure.
 */
async function ingestLogs(token: string, installedAppId: string): Promise<void> {
    const entries = await listLogs(token, LOG_PAGE);
    if (entries.length === 0) return;

    const devices = await prisma.placeDevice.findMany({
        where: { installedAppId, vendor: NUKI_VENDOR },
        select: { id: true, externalId: true }
    });
    const byExternal = new Map(devices.map((device) => [device.externalId, device.id]));

    const rows = entries.flatMap((entry) => {
        const deviceId = entry.smartlockId === undefined ? null : byExternal.get(String(entry.smartlockId));
        if (!deviceId) return [];
        return [{ deviceId, ...translateLog(entry) }];
    });
    if (rows.length === 0) return;
    await prisma.placeDeviceEvent.createMany({ data: rows, skipDuplicates: true });
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/** Only the actions a Nuki has. The list of buttons a kind of device gets is
 *  `actionsFor`, and it never offers a lock an "On" - this is the same rule said
 *  again at the edge, because what is on the other side of it is somebody's front
 *  door and a number sent in error is not a mistake worth being relaxed about. */
const ACTION_CODES: Readonly<Partial<Record<DeviceAction, number>>> = {
    lock: NUKI_ACTIONS.lock,
    unlock: NUKI_ACTIONS.unlock,
    unlatch: NUKI_ACTIONS.unlatch
};

/**
 * Tell one device to do one thing.
 *
 * Nothing is written here. The state that follows is read back by the sync the
 * caller runs afterwards, and the entry in the history comes from Nuki's own log,
 * so the record says what the lock did rather than what Polaris asked for - which
 * are not the same thing when a motor jams.
 */
export async function actOnNuki(externalId: string, action: DeviceAction): Promise<void> {
    const code = ACTION_CODES[action];
    if (code === undefined) {
        throw new HomeError(`A Nuki device cannot be told to ${DEVICE_ACTION_VERBS[action]}`);
    }
    const token = await requireToken();
    await speaking(() => performAction(token, externalId, code));
}
