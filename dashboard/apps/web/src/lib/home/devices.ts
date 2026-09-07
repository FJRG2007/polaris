/**
 * The devices at a place: reading them, acting on them, and what they have done.
 *
 * A camera is looked at; a door is used. That is the whole difference, and it is
 * why this is not part of `cameras`: what matters about a lock is its state, the
 * two buttons that change it, and the record of every time it changed - none of
 * which a camera has.
 *
 * Vendor-agnostic on purpose. `vendor` on the row picks the driver, and the
 * driver is the only thing that knows a make's numbering (see `nuki-devices`).
 * Adding a second make is a driver and a case in `driverFor`; no screen, no
 * action and no table changes.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "@/lib/home/home-error";
import { NUKI_VENDOR, actOnNuki, nukiConnection, syncNuki } from "@/lib/home/nuki-devices";
import {
    USAGE_DAYS,
    actionsFor,
    deviceState,
    doorState,
    type DeviceAction,
    type DeviceEventView,
    type DeviceView
} from "@/lib/home/device-kinds";

/** The makes Polaris can talk to. One entry, and the shape is the point: it is
 *  what keeps every caller below from naming one. */
const DRIVERS = {
    [NUKI_VENDOR]: { act: actOnNuki, sync: syncNuki }
} as const;

function driverFor(vendor: string): (typeof DRIVERS)[keyof typeof DRIVERS] {
    const driver = DRIVERS[vendor as keyof typeof DRIVERS];
    if (!driver) throw new HomeError("That device is connected through something Polaris no longer supports");
    return driver;
}

/** Which of the actions this door counts as somebody using it, for the chart. A
 *  door opening on its own sensor is the same event seen twice. */
const USED_ACTIONS = ["lock", "unlock", "unlatch", "lock-and-go"];

/** A ceiling on the rows one usage window reads. A door used more often than this
 *  in a month is a turnstile, and the chart of it would be a solid block either
 *  way. */
const USAGE_CEILING = 5000;

const DEVICE_FIELDS = {
    id: true,
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
    stateAt: true
} as const;

type DeviceRow = {
    id: string;
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
    stateAt: Date | null;
};

function toView(row: DeviceRow): DeviceView {
    return {
        id: row.id,
        vendor: row.vendor,
        kind: row.kind,
        name: row.name,
        zone: row.zone ?? "",
        placeId: row.placeId,
        model: row.model ?? "",
        firmware: row.firmware ?? "",
        state: deviceState(row.state),
        doorState: doorState(row.doorState),
        batteryPercent: row.batteryPercent,
        batteryCritical: row.batteryCritical,
        online: row.online,
        controllable: row.controllable,
        stateAt: row.stateAt?.toISOString() ?? null
    };
}

/**
 * Every device at a place, or at all of them.
 *
 * Ordered by where they are and then by name, which is how somebody standing in a
 * building reads a list of its doors: the front ones together, the back ones
 * together.
 */
export async function listDevices(installedAppId: string, placeId?: string | null): Promise<DeviceView[]> {
    const rows = await prisma.placeDevice.findMany({
        where: { installedAppId, ...(placeId ? { placeId } : {}) },
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

export async function getDevice(installedAppId: string, id: string): Promise<DeviceView> {
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
): Promise<DeviceView> {
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
 * Three refusals before anything leaves the building, and each of them is a
 * different mistake: an action this kind of device does not have, a device
 * somebody has deliberately taken off the controls, and a device that was not
 * answering when it was last asked. The last one is a refusal rather than an
 * attempt because a command sent into silence looks exactly like one that
 * worked, and the door being open is the wrong thing to be unsure about.
 *
 * The state is set to moving rather than to what was asked for. A lock told to
 * lock is a lock that is turning; whether it got there comes back from the
 * account, in the log, which is also where the history entry comes from - so the
 * record says what the door did rather than what Polaris wanted.
 */
export async function actOnDevice(
    installedAppId: string,
    id: string,
    action: DeviceAction
): Promise<DeviceView> {
    const device = await requireDevice(installedAppId, id);
    if (!actionsFor(device.kind).includes(action)) {
        throw new HomeError(`A ${device.kind} cannot be told to ${action}`);
    }
    if (!device.controllable) throw new HomeError(`${device.name} is set to be watched, not operated`);
    if (!device.online) throw new HomeError(`${device.name} was not answering when it was last checked`);

    try {
        await driverFor(device.vendor).act(device.externalId, action);
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
        throw caught;
    }

    const row = await prisma.placeDevice.update({
        where: { id: device.id },
        data: { state: "moving", stateAt: new Date() },
        select: DEVICE_FIELDS
    });
    return toView(row);
}

/**
 * Go and ask the accounts what they have.
 *
 * Every connected make, one after the other, and one of them failing does not
 * stop the rest: a Nuki account that is refusing its token must not leave a
 * second make's doors unread.
 */
export async function syncDevices(installedAppId: string): Promise<{ devices: number; error: string | null }> {
    let devices = 0;
    let error: string | null = null;
    for (const [vendor, driver] of Object.entries(DRIVERS)) {
        if (vendor === NUKI_VENDOR && !(await nukiConnection()).connected) continue;
        try {
            devices += (await driver.sync(installedAppId)).devices;
        } catch (caught) {
            error = caught instanceof Error ? caught.message : "That account could not be reached";
        }
    }
    return { devices, error };
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
): Promise<DeviceEventView[]> {
    const rows = await prisma.placeDeviceEvent.findMany({
        where: {
            device: {
                installedAppId,
                ...(query.deviceId ? { id: query.deviceId } : {}),
                ...(query.placeId ? { placeId: query.placeId } : {})
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
export async function deviceUsage(installedAppId: string, deviceId: string, days = USAGE_DAYS): Promise<number[]> {
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
