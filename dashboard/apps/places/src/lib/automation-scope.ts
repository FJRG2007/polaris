/**
 * What an automation's areas are read against on each run: the devices at its
 * place with the room each is in and the labels each carries, and the floor
 * each room is on. A device in no room still counts for the whole place and for
 * its labels. Bounded by what one house has.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { TargetScope } from "./automation-kinds";

export async function targetScope(installedAppId: string, placeId: string): Promise<TargetScope> {
    const [devices, rooms] = await Promise.all([
        prisma.placeDevice.findMany({
            where: { installedAppId, placeId },
            select: {
                id: true,
                kind: true,
                controllable: true,
                roomId: true,
                labels: { select: { labelId: true } }
            },
            take: 1000
        }),
        prisma.placeRoom.findMany({
            where: { installedAppId, placeId },
            select: { id: true, floorId: true },
            take: 500
        })
    ]);
    return {
        devices: devices.map(({ labels, ...device }) => ({
            ...device,
            labelIds: labels.map((label) => label.labelId)
        })),
        rooms: rooms.map((room) => ({ id: room.id, floorId: room.floorId ?? "" }))
    };
}
