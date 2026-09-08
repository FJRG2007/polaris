/**
 * The devices at a place: reading them, acting on them, and what they have done.
 *
 * A camera is looked at; a device is used. That is the whole difference, and it
 * is why this is not part of `cameras`: what matters about a lock or a socket is
 * its state, the buttons that change it, and the record of every time it changed
 * - none of which a camera has.
 *
 * Make-agnostic on purpose, and account-driven. A device belongs to a connected
 * account, the account names a connection, and the connection names the driver
 * that is the only thing in the app knowing one make's numbering. Adding a make -
 * or a second way in to a make already here - is a driver and a registry entry:
 * no screen, no action and no table changes.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as kinds from "@/lib/home/device-kinds";
import { HomeError } from "@/lib/home/home-error";
import { dropGrantsFor } from "@/lib/access/grants";
import * as accounts from "@/lib/home/device-accounts";
import { DriverError, type DeviceHistoryEntry } from "@/lib/home/drivers/contract";

/** What a sync was asked for. `probe` is somebody pressing the button rather than
 *  a timer coming round, and a driver may spend something on it - waking a lock
 *  over its radio, say - that a background read must never spend. */
export interface SyncOptions {
    readonly probe?: boolean;
}

/** Which of the actions count as somebody using the thing, for the chart. A door
 *  opening on its own sensor is the same event seen twice. */
const USED_ACTIONS = ["lock", "unlock", "unlatch", "lock-and-go", "turn-on", "turn-off"];

/** A ceiling on the rows one usage window reads. A door used more often than this
 *  in a month is a turnstile, and the chart of it would be a solid block either
 *  way. */
const USAGE_CEILING = 5000;

/** How much of an account's own log one sync reads. The entries already written
 *  are skipped rather than duplicated, so re-reading the overlap costs nothing
 *  and is what makes a missed sync heal itself. */
const HISTORY_PAGE = 200;

const DEVICE_FIELDS = {
    id: true,
    accountId: true,
    vendor: true,
    kind: true,
    name: true,
    zone: true,
    placeId: true,
    model: true,
    firmware: true,
    state: true,
    doorState: true,
    batteryPercent: true,
    batteryCritical: true,
    online: true,
    controllable: true,
    value: true,
    unit: true,
    stateAt: true
} as const;

type DeviceRow = {
    id: string;
    accountId: string | null;
    vendor: string;
    kind: string;
    name: string;
    zone: string | null;
    placeId: string | null;
    model: string | null;
    firmware: string | null;
    state: string;
    doorState: string;
    batteryPercent: number | null;
    batteryCritical: boolean;
    online: boolean;
    controllable: boolean;
    value: string | null;
    unit: string | null;
    stateAt: Date | null;
};

function toView(row: DeviceRow): kinds.DeviceView {
    return {
        id: row.id,
        vendor: row.vendor,
        kind: row.kind,
        name: row.name,
        zone: row.zone ?? "",
        placeId: row.placeId,
        model: row.model ?? "",
        firmware: row.firmware ?? "",
        state: kinds.deviceState(row.state),
        doorState: kinds.doorState(row.doorState),
        batteryPercent: row.batteryPercent,
        batteryCritical: row.batteryCritical,
        online: row.online,
        controllable: row.controllable,
        // Both or neither: a unit with nothing to put it after is not a reading,
        // and a screen that drew one would print a bare "C".
        reading: row.value ? { value: row.value, unit: row.unit ?? "" } : null,
        stateAt: row.stateAt?.toISOString() ?? null
    };
}

/**
 * Every device at a place, or at all of them.
 *
 * Ordered by where they are and then by name, which is how somebody standing in a
 * building reads a list of its doors: the front ones together, the back ones
 * together.
 *
 * A device that has not been put anywhere yet is in every place's list, not none
 * of them. An account arrives knowing what it holds and not where any of it is,
 * so everything lands here unplaced - and a list that filtered those out showed
 * an empty screen telling the reader to open one and say where it was, with
 * nothing on it to open. They are listed and marked instead, and putting one
 * somewhere is what takes it off the other places' lists.
 */
export async function listDevices(installedAppId: string, placeId?: string | null): Promise<kinds.DeviceView[]> {
    const rows = await prisma.placeDevice.findMany({
        where: { installedAppId, ...(placeId ? { OR: [{ placeId }, { placeId: null }] } : {}) },
        orderBy: [{ zone: "asc" }, { name: "asc" }],
        select: DEVICE_FIELDS
    });
    return rows.map(toView);
}

/** One device, refusing rather than answering when it is not this install's. */
async function requireDevice(installedAppId: string, id: string): Promise<DeviceRow & { externalId: string }> {
    const row = await prisma.placeDevice.findFirst({
        where: { id, installedAppId },
        select: { ...DEVICE_FIELDS, externalId: true }
    });
    if (!row) throw new HomeError("That device is not here");
    return row;
}

export async function getDevice(installedAppId: string, id: string): Promise<kinds.DeviceView> {
    return toView(await requireDevice(installedAppId, id));
}

/** What somebody can change about a device from here. Everything else about it
 *  belongs to the account it came from and is read back by every sync. */
export interface DeviceEdit {
    readonly name: string;
    readonly zone: string;
    readonly placeId: string | null;
    readonly controllable: boolean;
}

export async function updateDevice(
    installedAppId: string,
    id: string,
    edit: DeviceEdit
): Promise<kinds.DeviceView> {
    await requireDevice(installedAppId, id);
    const row = await prisma.placeDevice.update({
        where: { id },
        data: {
            name: edit.name,
            zone: edit.zone || null,
            placeId: edit.placeId,
            controllable: edit.controllable
        },
        select: DEVICE_FIELDS
    });
    return toView(row);
}

/**
 * Do something to a device.
 *
 * Four refusals before anything leaves the building, and each of them is a
 * different mistake: an action this kind of device does not have, a device
 * somebody has deliberately taken off the controls, a device whose account is no
 * longer here, and a device that was not answering when it was last asked. The
 * last one is a refusal rather than an attempt because a command sent into
 * silence looks exactly like one that worked, and the door being open is the
 * wrong thing to be unsure about.
 *
 * A lock told to lock is set to moving rather than to locked: it is a lock that
 * is turning, and whether it got there comes back from the account, in the log,
 * which is also where the history entry comes from - so the record says what the
 * door did rather than what Polaris wanted. A socket has no such gap, so it is
 * written as what it was told to be.
 */
export async function actOnDevice(
    installedAppId: string,
    id: string,
    action: kinds.DeviceAction,
    actor: string = ""
): Promise<kinds.DeviceView> {
    const device = await requireDevice(installedAppId, id);
    if (!kinds.actionsFor(device.kind).includes(action)) {
        const what = kinds.DEVICE_KIND_LABELS[kinds.deviceKind(device.kind)].toLowerCase();
        throw new HomeError(`A ${what} cannot be told to ${kinds.DEVICE_ACTION_VERBS[action]}`);
    }
    if (!device.controllable) throw new HomeError(`${device.name} is set to be watched, not operated`);
    if (!device.accountId) throw new HomeError(`${device.name} is not connected to anything`);
    if (!device.online) throw new HomeError(`${device.name} was not answering when it was last checked`);

    const { view, credentials } = await accounts.accountWithCredentials(installedAppId, device.accountId);
    const driver = accounts.driverFor(view.connection);
    try {
        await driver.act(credentials, { externalId: device.externalId, kind: device.kind }, action);
    } catch (caught) {
        // Written down even though it never happened. A door that refused to move
        // is exactly what somebody comes to this history for, and the account's
        // own log has nothing to say about a command it declined.
        await prisma.placeDeviceEvent.create({
            data: {
                deviceId: device.id,
                action,
                via: "polaris",
                outcome: "failed",
                note: caught instanceof Error ? caught.message : null,
                at: new Date()
            }
        });
        throw caught instanceof DriverError ? new HomeError(caught.message) : caught;
    }

    // Where the make keeps a log of its own, the entry comes from there on the
    // next sync - which is better, because it says what the device did rather
    // than what it was told. Where it does not, this is the only record there
    // will ever be, and a history that only ever showed the presses that failed
    // would be a history nobody could read.
    if (!driver.history) {
        await prisma.placeDeviceEvent.create({
            data: {
                deviceId: device.id,
                action,
                actor: actor.trim() || null,
                via: "polaris",
                outcome: "ok",
                at: new Date()
            }
        });
    }

    const row = await prisma.placeDevice.update({
        where: { id: device.id },
        data: { state: kinds.settledState(action) ?? "moving", stateAt: new Date() },
        select: DEVICE_FIELDS
    });
    return toView(row);
}

/**
 * Go and ask every connected account what it has.
 *
 * One after the other, and one of them failing does not stop the rest: an account
 * that is refusing its token must not leave a second make's devices unread. What
 * went wrong is remembered on the account it went wrong on, so a screen can say
 * which of them is the problem rather than putting one line above everything.
 */
export async function syncDevices(
    installedAppId: string,
    options: SyncOptions = {}
): Promise<{ devices: number; error: string | null }> {
    const connected = await accounts.listAccounts(installedAppId);
    let devices = 0;
    let error: string | null = null;
    for (const account of connected) {
        if (!accounts.isConnectable(account.connection)) continue;
        try {
            devices += await syncAccount(installedAppId, account.id, options);
        } catch (caught) {
            error = caught instanceof Error ? caught.message : `${account.label} could not be reached`;
        }
    }
    return { devices, error };
}

/** One account: what it holds now, and what has happened on it. */
async function syncAccount(
    installedAppId: string,
    accountId: string,
    options: SyncOptions
): Promise<number> {
    const { view, credentials } = await accounts.accountWithCredentials(installedAppId, accountId);
    const driver = accounts.driverFor(view.connection);
    try {
        if (options.probe === true && driver.probe) {
            const known = await prisma.placeDevice.findMany({
                where: { accountId },
                select: { externalId: true }
            });
            await driver.probe(
                credentials,
                known.map((device) => device.externalId)
            );
        }

        const snapshots = await driver.list(credentials);
        const vendor = view.brand.toLowerCase();
        for (const snapshot of snapshots) {
            const reading = {
                kind: snapshot.kind,
                model: snapshot.model,
                firmware: snapshot.firmware,
                state: snapshot.state,
                doorState: snapshot.doorState,
                batteryPercent: snapshot.batteryPercent,
                batteryCritical: snapshot.batteryCritical,
                online: snapshot.online,
                value: snapshot.value ?? null,
                unit: snapshot.unit ?? null,
                stateAt: new Date()
            };
            await prisma.placeDevice.upsert({
                where: { accountId_externalId: { accountId, externalId: snapshot.externalId } },
                // The name, the place and the zone are not overwritten on the way
                // in: a door renamed here is renamed for a reason, and a sync that
                // put "Smart Lock 4" back over "Warehouse side door" every minute
                // would make the field pointless.
                update: reading,
                create: {
                    ...reading,
                    installedAppId,
                    accountId,
                    vendor,
                    externalId: snapshot.externalId,
                    name: snapshot.name
                }
            });
        }

        // Anything on our side the account no longer has. A device somebody sold
        // is not a device this house has, and leaving the row would leave a button
        // that answers with an error nobody can act on.
        const gone = await prisma.placeDevice.findMany({
            where: {
                accountId,
                externalId: { notIn: snapshots.map((snapshot) => snapshot.externalId) }
            },
            select: { id: true }
        });
        // Whatever was lent of a device that is no longer here. The rows are
        // addressed by kind and id rather than by foreign key, so nothing drops
        // them on the device's behalf - and a share of a door somebody sold
        // should not be waiting if another arrives with the same id.
        for (const device of gone) await dropGrantsFor("place.device", device.id);
        await prisma.placeDevice.deleteMany({
            where: { id: { in: gone.map((device) => device.id) } }
        });

        if (driver.history) await ingestHistory(accountId, await driver.history(credentials, HISTORY_PAGE));
        await accounts.markSynced(accountId);
        return snapshots.length;
    } catch (caught) {
        if (caught instanceof DriverError) {
            await accounts.markAccount(
                accountId,
                caught.kind === "unauthorized" ? "unauthorized" : "unreachable",
                caught.message
            );
            throw new HomeError(caught.message);
        }
        throw caught;
    }
}

/**
 * An account's own log, written down as ours.
 *
 * `createMany` with `skipDuplicates` rather than a read-then-write: the unique key
 * on (device, their id) is what decides, so two syncs racing each other write the
 * same history once and neither has to hold a lock to be sure.
 */
async function ingestHistory(accountId: string, entries: readonly DeviceHistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const devices = await prisma.placeDevice.findMany({
        where: { accountId },
        select: { id: true, externalId: true }
    });
    const byExternal = new Map(devices.map((device) => [device.externalId, device.id]));

    const rows = entries.flatMap((entry) => {
        const deviceId = byExternal.get(entry.deviceExternalId);
        if (!deviceId) return [];
        return [
            {
                deviceId,
                externalId: entry.externalId,
                action: entry.action,
                actor: entry.actor,
                via: entry.via,
                outcome: entry.outcome,
                note: entry.note,
                at: entry.at
            }
        ];
    });
    if (rows.length === 0) return;
    await prisma.placeDeviceEvent.createMany({ data: rows, skipDuplicates: true });
}

/**
 * What has happened, newest first.
 *
 * One device or all of them, because both are questions people ask: "what has
 * this door done today" and "what has happened at this place while I was away".
 */
export async function listDeviceEvents(
    installedAppId: string,
    query: { deviceId?: string | null; placeId?: string | null; limit?: number }
): Promise<kinds.DeviceEventView[]> {
    const rows = await prisma.placeDeviceEvent.findMany({
        where: {
            device: {
                installedAppId,
                ...(query.deviceId ? { id: query.deviceId } : {}),
                // Unplaced devices belong to this list for the same reason they
                // belong to the one above: they are on the screen, so what they
                // did has to be readable from it.
                ...(query.placeId ? { OR: [{ placeId: query.placeId }, { placeId: null }] } : {})
            }
        },
        orderBy: { at: "desc" },
        take: Math.max(1, Math.min(500, query.limit ?? 100)),
        select: {
            id: true,
            deviceId: true,
            action: true,
            actor: true,
            via: true,
            outcome: true,
            note: true,
            at: true,
            device: { select: { name: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        deviceName: row.device.name,
        action: row.action,
        actor: row.actor ?? "",
        via: row.via,
        outcome: row.outcome,
        note: row.note ?? "",
        at: row.at.toISOString()
    }));
}

/**
 * When a device was used over the last month, as bare timestamps.
 *
 * Bucketed into days by the screen rather than here, and that is deliberate: a
 * day starts at midnight where the reader is, the window spans a daylight-saving
 * change twice a year, and the server is the one party to this that does not know
 * which zone to ask about. The list is bounded and small - a month of a busy
 * office door is a few hundred entries - so sending the times costs less than
 * plumbing a timezone down to a query.
 */
export async function deviceUsage(
    installedAppId: string,
    deviceId: string,
    days = kinds.USAGE_DAYS
): Promise<number[]> {
    await requireDevice(installedAppId, deviceId);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.placeDeviceEvent.findMany({
        where: { deviceId, outcome: "ok", action: { in: USED_ACTIONS }, at: { gte: from } },
        orderBy: { at: "asc" },
        take: USAGE_CEILING,
        select: { at: true }
    });
    return rows.map((row) => row.at.getTime());
}
