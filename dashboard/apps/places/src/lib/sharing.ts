/**
 * Lending one door, or one camera, to somebody who does not live here.
 *
 * Places has always been all-or-nothing: `home.read` shows every camera in every
 * place and `home.control` opens every lock in them. That is right for the
 * people who live somewhere and wrong for everybody else - the cleaner, the
 * neighbour feeding the cat, the security team who should see the yard and
 * nothing else. Every lock brand solves this the same way and it is the reason
 * people buy them: a key that works on one door, on the days you say, between
 * the hours you say, a set number of times.
 *
 * So a grant (`lib/access/grants.ts`) is the second way in, and it is a
 * narrowing rather than a widening:
 *
 * - somebody holding `home.read` reaches everything, exactly as before, and
 *   nothing here is consulted for them;
 * - somebody holding nothing reaches precisely what they were given, sees only
 *   that on the screen, and is refused everything else;
 * - `home.control` is what opens a door for a resident; a `control` grant is
 *   what opens one door for a visitor, and it is counted.
 *
 * **Only an act spends a use.** Drawing the lock, reading whether it is shut,
 * refreshing the screen - none of those are opening the door, and a four-use
 * grant that spent one on every render would be finished before the visitor
 * arrived. The spend happens after the device actually moved, so a door that
 * refused costs nothing.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { grantActionFor, type DeviceAction } from "./device-kinds";

const { sessionCan } = host.session;
const { grantedActions, grantedSubjects, liveGrants, reachesAnySubject, spendGrant } =
    host.accessGrants;
type SessionUser = AppHostTypes["SessionUser"];
type LiveGrant = AppHostTypes["LiveGrant"];

/** A grant as it was used, with what it was over - a device itself, or the
 *  room the device is in - so the access log can say which key opened it. */
export type LentGrant = LiveGrant & {
    readonly subjectType: "place.device" | "place.camera" | "place.room";
    readonly subjectId: string;
};

/**
 * The rooms a device is in: one, or none. A device moved into a room later is
 * covered by that room's grants from then on, and one moved out stops being.
 */
async function roomsOfDevice(deviceId: string): Promise<string[]> {
    const row = await prisma.placeDevice
        .findUnique({ where: { id: deviceId }, select: { roomId: true } })
        .catch(() => null);
    return row?.roomId ? [row.roomId] : [];
}

/**
 * The rooms a camera is in: the room it was put in, or - for a camera never
 * put in one - a room of the same place whose name its free-text `zone`
 * repeats (ignoring case), which is how cameras were grouped before rooms.
 */
export async function roomsOfCamera(cameraId: string): Promise<string[]> {
    const camera = await prisma.camera
        .findUnique({
            where: { id: cameraId },
            select: { placeId: true, zone: true, roomId: true }
        })
        .catch(() => null);
    if (camera?.roomId) return [camera.roomId];
    const zone = camera?.zone?.trim();
    if (!camera?.placeId || !zone) return [];
    const rooms = await prisma.placeRoom.findMany({
        where: { placeId: camera.placeId, name: { equals: zone, mode: "insensitive" } },
        select: { id: true },
        take: 10
    });
    return rooms.map((room) => room.id);
}

/** What one room covers right now: its devices and its cameras, by id. */
export async function roomContents(
    roomIds: readonly string[]
): Promise<{ devices: Map<string, string>; cameras: Map<string, string> }> {
    const devices = new Map<string, string>();
    const cameras = new Map<string, string>();
    if (roomIds.length === 0) return { devices, cameras };
    const rooms = await prisma.placeRoom.findMany({
        where: { id: { in: [...roomIds] } },
        select: { id: true, name: true, placeId: true },
        take: 200
    });
    const [deviceRows, cameraRows] = await Promise.all([
        prisma.placeDevice.findMany({
            where: { roomId: { in: rooms.map((room) => room.id) } },
            select: { id: true, roomId: true },
            take: 2000
        }),
        prisma.camera.findMany({
            where: {
                OR: [
                    { roomId: { in: rooms.map((room) => room.id) } },
                    ...rooms.map((room) => ({
                        roomId: null,
                        placeId: room.placeId,
                        zone: { equals: room.name, mode: "insensitive" as const }
                    }))
                ]
            },
            select: { id: true, placeId: true, zone: true, roomId: true },
            take: 2000
        })
    ]);
    for (const device of deviceRows) if (device.roomId) devices.set(device.id, device.roomId);
    for (const camera of cameraRows) {
        if (camera.roomId) {
            if (rooms.some((one) => one.id === camera.roomId)) cameras.set(camera.id, camera.roomId);
            continue;
        }
        const room = rooms.find(
            (one) =>
                one.placeId === camera.placeId &&
                one.name.toLowerCase() === (camera.zone ?? "").trim().toLowerCase()
        );
        if (room) cameras.set(camera.id, room.id);
    }
    return { devices, cameras };
}

/** Live grants over any of these rooms, each tagged with its room. */
async function roomGrants(userId: string, roomIds: readonly string[]): Promise<LentGrant[]> {
    const found = await Promise.all(
        roomIds.map(async (roomId) =>
            (await liveGrants(userId, "place.room", roomId)).map((grant) => ({
                ...grant,
                subjectType: "place.room" as const,
                subjectId: roomId
            }))
        )
    );
    return found.flat();
}

/** The stronger of two capabilities on the same device ladder. */
function stronger(held: string | undefined, other: string): string {
    if (!held) return other;
    return core.atLeast("place.device", held, other) ? held : other;
}

/** What one account reaches in Places. */
export interface PlacesReach {
    /**
     * Whether they hold the app's own read permission, and so reach the house
     * rather than a piece of it. Everything below is empty and unread for them:
     * a resident is not a visitor with a lot of grants.
     */
    readonly everything: boolean;
    /** Which cameras they were lent, and what they may do with each. */
    readonly cameras: ReadonlyMap<string, string>;
    /** The same for doors, openers, switches and sensors. */
    readonly devices: ReadonlyMap<string, string>;
    /** What a visitor may do with each device they were lent: open, close,
     *  operate (`core.GRANT_ACTIONS`). Empty for a resident. */
    readonly deviceActions: ReadonlyMap<string, readonly string[]>;
    /** The UPSes they were lent. Their screens are core's; Places lists them on
     *  the place they stand in, so somebody lent only a UPS has a way to it. */
    readonly upses: ReadonlyMap<string, string>;
}

/**
 * What this account reaches, resolved once for a screen.
 *
 * Two queries for somebody who was lent something and none for somebody who
 * lives here, which is the common case and the one worth not paying for.
 */
export async function placesReach(user: SessionUser): Promise<PlacesReach> {
    if (await sessionCan(user, "home.read")) {
        return {
            everything: true,
            cameras: new Map(),
            devices: new Map(),
            deviceActions: new Map(),
            upses: new Map()
        };
    }
    const [cameraGrants, deviceGrants, deviceGrantActions, upses, rooms, roomActions] =
        await Promise.all([
            grantedSubjects(user.id, "place.camera"),
            grantedSubjects(user.id, "place.device"),
            grantedActions(user.id, "place.device"),
            grantedSubjects(user.id, "place.ups"),
            grantedSubjects(user.id, "place.room"),
            grantedActions(user.id, "place.room")
        ]);
    const cameras = new Map(cameraGrants);
    const devices = new Map(deviceGrants);
    const deviceActions = new Map(deviceGrantActions);
    // A room lent is everything in it, read now: what was put in it since the
    // grant was written is in, what was taken out is not.
    if (rooms.size > 0) {
        const inside = await roomContents([...rooms.keys()]);
        for (const [deviceId, roomId] of inside.devices) {
            const held = rooms.get(roomId)!;
            devices.set(deviceId, stronger(devices.get(deviceId), held));
            const actions = (roomActions.get(roomId) ?? []).filter((one) => one !== "watch");
            deviceActions.set(deviceId, [
                ...new Set([...(deviceActions.get(deviceId) ?? []), ...actions])
            ]);
        }
        for (const [cameraId] of inside.cameras) {
            if (!cameras.has(cameraId)) cameras.set(cameraId, "view");
        }
    }
    return { everything: false, cameras, devices, deviceActions, upses };
}

/** Whether a visitor's reach holds nothing at all, which is a refusal. */
export function reachesNothing(reach: PlacesReach): boolean {
    return (
        !reach.everything &&
        reach.cameras.size === 0 &&
        reach.devices.size === 0 &&
        reach.upses.size === 0
    );
}

/**
 * Whether they reach Places at all, which is what decides if the app is in
 * their switcher. Somebody lent one door has an app to open.
 *
 * On the path that draws the navigation of every screen in the app, and asked
 * for everybody who does not hold `home.read` - which is most people. So it is
 * one query for both kinds rather than one each, and it is held for the length
 * of a request: a page that resolves its navigation, its landing path and a
 * refusal's destination asks this three times and pays for it once.
 */
export const reachesPlaces = cache(async (userId: string): Promise<boolean> =>
    reachesAnySubject(userId, [
        "place.camera",
        "place.device",
        "place.ups",
        "place.nas",
        "place.server",
        "place.domain",
        "place.room"
    ])
);

/** Whether a reach covers one camera. */
export function reachesCamera(reach: PlacesReach, cameraId: string): boolean {
    return reach.everything || reach.cameras.has(cameraId);
}

/** And one device, at the strength asked for. */
export function reachesDevice(
    reach: PlacesReach,
    deviceId: string,
    wanted: "view" | "control" = "view"
): boolean {
    if (reach.everything) return true;
    const held = reach.devices.get(deviceId);
    return Boolean(held && core.atLeast("place.device", held, wanted));
}

/**
 * Whatever of a list this account may see.
 *
 * Given the whole list and returning part of it, rather than narrowing the
 * query: the reach is a set of ids resolved from grants that no database join
 * reaches, and a house has tens of cameras rather than thousands.
 */
export function onlyReachable<T extends { id: string }>(
    things: readonly T[],
    allowed: ReadonlyMap<string, string> | true
): T[] {
    return allowed === true ? [...things] : things.filter((thing) => allowed.has(thing.id));
}

/**
 * Whether this account may watch one camera.
 *
 * The question the three routes that serve pictures ask - the stream, the
 * snapshot and the playlist - and it has to be all three, because a camera whose
 * live view is refused and whose stills are not is a camera that is not refused.
 */
export async function mayWatchCamera(user: SessionUser, cameraId: string): Promise<boolean> {
    if (await sessionCan(user, "home.read")) return true;
    if ((await liveGrants(user.id, "place.camera", cameraId)).length > 0) return true;
    return (await roomGrants(user.id, await roomsOfCamera(cameraId))).length > 0;
}

/**
 * Log a visitor opening a camera's live view - once per view, from the routes
 * that start one (the MP4 stream and the HLS master playlist), never per frame
 * or segment. A resident is not a visitor and is not logged here.
 */
export async function logCameraWatch(user: SessionUser, cameraId: string): Promise<void> {
    if (await sessionCan(user, "home.read")) return;
    const direct = await liveGrants(user.id, "place.camera", cameraId);
    const grant: LentGrant | undefined = direct[0]
        ? { ...direct[0], subjectType: "place.camera", subjectId: cameraId }
        : (await roomGrants(user.id, await roomsOfCamera(cameraId)))[0];
    if (!grant) return;
    await host.accessGrants.recordGrantUse({
        grantId: grant.id,
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        targetType: "camera",
        targetId: cameraId,
        userId: user.id,
        action: "watch",
        outcome: "done"
    });
}

/** Refused because this camera was not lent to them. The same sentence whether
 *  it exists or not: a stranger guessing ids learns nothing either way. */
export async function requireCameraView(user: SessionUser, cameraId: string): Promise<void> {
    if (!(await mayWatchCamera(user, cameraId))) {
        throw new HomeError("That camera is not shared with you");
    }
}

/**
 * The right to open one door, and the grant that gives it.
 *
 * A resident gets null: they hold `home.control`, and there is nothing to
 * count. A visitor gets the grant back so the caller can spend it *after* the
 * door has actually moved - see the note at the top of this file.
 */
export async function requireDeviceControl(
    user: SessionUser,
    deviceId: string,
    action: DeviceAction
): Promise<LentGrant | null> {
    if (await sessionCan(user, "home.control")) return null;
    const held: LentGrant[] = [
        ...(await liveGrants(user.id, "place.device", deviceId)).map((grant) => ({
            ...grant,
            subjectType: "place.device" as const,
            subjectId: deviceId
        })),
        ...(await roomGrants(user.id, await roomsOfDevice(deviceId)))
    ];
    // The grant has to allow this direction: a key lent to open the door does
    // not lock it, and one lent to lock it at night does not open it.
    const wanted = grantActionFor(action);
    const usable = held.find(
        (grant) =>
            core.atLeast("place.device", grant.capability, "control") &&
            grant.actions.includes(wanted)
    );
    if (!usable) {
        // Deliberately one sentence for three cases - never lent, lent but out
        // of hours, lent but used up - because the screen says which: it has the
        // grant in front of it, and this is the path somebody reaches by editing
        // an address.
        if (held.length > 0) {
            await host.accessGrants.recordGrantUse({
                grantId: held[0]!.id,
                subjectType: held[0]!.subjectType,
                subjectId: held[0]!.subjectId,
                targetType: "device",
                targetId: deviceId,
                userId: user.id,
                action,
                outcome: "refused",
                reason: "notThat"
            });
        }
        throw new HomeError("You cannot operate that from here");
    }
    return usable;
}

/** Seeing a device, which is the weaker half of the same question. */
export async function requireDeviceView(user: SessionUser, deviceId: string): Promise<void> {
    if (await sessionCan(user, "home.read")) return;
    const held = await liveGrants(user.id, "place.device", deviceId);
    if (held.length > 0) return;
    const viaRoom = await roomGrants(user.id, await roomsOfDevice(deviceId));
    if (viaRoom.length === 0) throw new HomeError("That device is not shared with you");
}

/**
 * Count the use, now that the thing has happened.
 *
 * Never before: a door that would not move has not been used, and charging a
 * visitor for it would leave them locked out by a failure that was not theirs.
 *
 * And never the other way round either. This is bookkeeping about an act that is
 * already over - the door has moved - so a grant revoked in between, or anything
 * else that goes wrong writing the count, is logged rather than raised. Telling
 * somebody the door did not open when it did is the worse of the two answers.
 */
export async function countDeviceUse(grant: LiveGrant | null): Promise<void> {
    if (!grant) return;
    try {
        await spendGrant(grant);
    } catch (caught) {
        console.error("places: a use could not be counted", caught);
    }
}
