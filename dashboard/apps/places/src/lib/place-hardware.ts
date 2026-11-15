/**
 * The cameras, UPSes and NASes at a place, for the devices list, and the room
 * each stands in.
 *
 * A UPS and a NAS are core's, not Places': their screens live outside this app
 * (a UPS keeps shutting machines down with Places uninstalled), so they are read
 * straight off their tables and listed only to whoever may open those screens -
 * a UPS to an administrator or the visitor it was lent to, a NAS to its owner
 * or the visitor it was lent to. Moving one to another room is managing the
 * house and managing that thing, so it needs both.
 *
 * Server-only.
 */

import * as rooms from "./rooms";
import { prisma } from "@polaris/db";
import * as cameras from "./cameras";
import * as devices from "./devices";
import { host } from "@polaris/app-host";
import { HomeError } from "./home-error";
import type { AppHostTypes } from "@polaris/app-host";
import { onlyReachable, type PlacesReach } from "./sharing";
import type { HardwareKind, HardwareView } from "./device-list";

type SessionUser = AppHostTypes["SessionUser"];

/** More than any one place holds; a list is bounded whatever is in the table. */
const LIMIT = 200;
const NAS_KIND = "unifi-unas";

export async function listPlaceHardware(
    installedAppId: string,
    placeId: string,
    user: SessionUser,
    reach: PlacesReach,
    managesHome: boolean
): Promise<HardwareView[]> {
    const lentUps = [...reach.upses.keys()];
    const [cameraList, administers, lentNas] = await Promise.all([
        cameras.listCameras(installedAppId, placeId),
        host.session.sessionCan(user, "system.manage"),
        host.accessGrants.grantedSubjects(user.id, "place.nas")
    ]);
    const lentNasIds = [...lentNas.keys()];
    const [upses, nases] = await Promise.all([
        administers || lentUps.length > 0
            ? prisma.ups.findMany({
                  where: { placeId, ...(administers ? {} : { id: { in: lentUps } }) },
                  select: { id: true, name: true, roomId: true },
                  orderBy: [{ name: "asc" }, { id: "asc" }],
                  take: LIMIT
              })
            : [],
        prisma.storageConnection.findMany({
            where: {
                kind: NAS_KIND,
                placeId,
                OR: [
                    { ownerId: user.id },
                    ...(lentNasIds.length > 0 ? [{ id: { in: lentNasIds } }] : [])
                ]
            },
            select: { id: true, name: true, roomId: true, ownerId: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: LIMIT
        })
    ]);
    return [
        ...onlyReachable(cameraList, reach.everything || reach.cameras).map((camera) => ({
            id: camera.id,
            kind: "camera" as const,
            name: camera.name,
            model: camera.model,
            roomId: camera.roomId || null,
            href: null,
            canArrange: managesHome
        })),
        ...upses.map((ups) => ({
            id: ups.id,
            kind: "ups" as const,
            name: ups.name,
            model: null,
            roomId: ups.roomId,
            href: `/places/ups/${ups.id}`,
            canArrange: managesHome && administers
        })),
        ...nases.map((nas) => ({
            id: nas.id,
            kind: "nas" as const,
            name: nas.name,
            model: null,
            roomId: nas.roomId,
            href: `/places/nas/${nas.id}`,
            canArrange: managesHome && nas.ownerId === user.id
        }))
    ];
}

/**
 * Put one thing in a room of the place it is at, or in none. The room is
 * checked to be this install's and at that same place; the caller has already
 * checked `home.manage`, and this checks what the thing itself needs on top.
 */
export async function assignRoom(
    installedAppId: string,
    user: SessionUser,
    kind: "device" | HardwareKind,
    id: string,
    roomId: string | null
): Promise<void> {
    const room = roomId ? await rooms.requireRoom(installedAppId, roomId) : null;
    const atPlace = (placeId: string | null) => {
        if (room && room.placeId !== placeId) throw new HomeError("That room is at another place");
    };
    if (kind === "device") {
        const device = await devices.requireDevice(installedAppId, id);
        atPlace(device.placeId);
        await devices.updateDevice(installedAppId, id, {
            name: device.name,
            zone: device.zone ?? "",
            placeId: device.placeId,
            controllable: device.controllable,
            roomId
        });
        return;
    }
    if (kind === "camera") {
        const camera = await prisma.camera.findFirst({
            where: { id, installedAppId },
            select: { placeId: true }
        });
        if (!camera) throw new HomeError("Camera not found");
        atPlace(camera.placeId);
        await prisma.camera.update({ where: { id }, data: { roomId } });
        return;
    }
    if (kind === "ups") {
        if (!(await host.session.sessionCan(user, "system.manage"))) {
            throw new HomeError("You do not have access to that");
        }
        const ups = await prisma.ups.findUnique({ where: { id }, select: { placeId: true } });
        if (!ups) throw new HomeError("UPS not found");
        atPlace(ups.placeId);
        await prisma.ups.update({ where: { id }, data: { roomId } });
        return;
    }
    const nas = await prisma.storageConnection.findFirst({
        where: { id, kind: NAS_KIND, ownerId: user.id },
        select: { placeId: true }
    });
    if (!nas) throw new HomeError("NAS not found");
    atPlace(nas.placeId);
    await prisma.storageConnection.update({ where: { id }, data: { roomId } });
}
