/**
 * The zones a camera has, as rows: reading them, drawing one, changing one,
 * removing one.
 *
 * The geometry lives in @polaris/core and is shared, because the editor, the
 * server and the worker all have to agree about what "inside" means. This is
 * the half that touches the database, and everything in it is scoped by the
 * install and the camera - a zone id from somewhere else must not resolve, the
 * same rule the cameras themselves are read under.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { OBJECT_CLASSES } from "@/lib/home/detection";
import type { CameraZoneInput } from "@/lib/home/schemas";
import { parseZoneObjects, parseZonePoints, serializeZonePoints, type Zone, type ZoneKind } from "@polaris/core";

/** A zone as a screen and the worker both see it. There is no second shape here:
 *  a zone carries no credential and nothing about it is worth hiding. */
export type CameraZoneView = Zone;

type ZoneRow = {
    id: string;
    name: string;
    kind: string;
    points: string;
    objects: string;
    inertia: number;
    loiterSeconds: number;
    enabled: boolean;
};

/** A row as everything downstream reads it. A polygon that no longer parses -
 *  hand-edited, or written by a version that stored something else - comes back
 *  with no points, and a zone with no points encloses nothing, so it stops
 *  narrowing the camera rather than breaking the screen that lists it. */
function toView(row: ZoneRow): CameraZoneView {
    return {
        id: row.id,
        name: row.name,
        kind: (row.kind === "ignore" ? "ignore" : "watch") satisfies ZoneKind,
        points: parseZonePoints(row.points),
        objects: parseZoneObjects(row.objects, OBJECT_CLASSES),
        inertia: row.inertia,
        loiterSeconds: row.loiterSeconds,
        enabled: row.enabled
    };
}

const SELECT = {
    id: true,
    name: true,
    kind: true,
    points: true,
    objects: true,
    inertia: true,
    loiterSeconds: true,
    enabled: true
} as const;

/** Every zone on one camera, in the order they were drawn. */
export async function listCameraZones(installedAppId: string, cameraId: string): Promise<CameraZoneView[]> {
    const rows = await prisma.cameraZone.findMany({
        where: { cameraId, camera: { installedAppId } },
        orderBy: { createdAt: "asc" },
        select: SELECT
    });
    return rows.map(toView);
}

/**
 * Every zone in the house, by camera.
 *
 * One query rather than one per camera: the worker asks for its whole
 * assignment list at once, and a house with twenty cameras should not cost
 * twenty round trips to answer a question about polygons.
 */
export async function zonesByCamera(installedAppId: string): Promise<Map<string, CameraZoneView[]>> {
    const rows = await prisma.cameraZone.findMany({
        where: { enabled: true, camera: { installedAppId } },
        orderBy: { createdAt: "asc" },
        select: { ...SELECT, cameraId: true }
    });
    const byCamera = new Map<string, CameraZoneView[]>();
    for (const row of rows) {
        const list = byCamera.get(row.cameraId) ?? [];
        list.push(toView(row));
        byCamera.set(row.cameraId, list);
    }
    return byCamera;
}

async function assertCamera(installedAppId: string, cameraId: string): Promise<void> {
    const camera = await prisma.camera.findFirst({ where: { id: cameraId, installedAppId }, select: { id: true } });
    if (!camera) throw new Error("Camera not found");
}

export async function createCameraZone(
    installedAppId: string,
    cameraId: string,
    input: CameraZoneInput
): Promise<CameraZoneView> {
    await assertCamera(installedAppId, cameraId);
    const row = await prisma.cameraZone.create({
        data: {
            cameraId,
            name: input.name,
            kind: input.kind,
            points: serializeZonePoints(input.points.map(([x, y]) => ({ x, y }))),
            objects: JSON.stringify(input.objects),
            inertia: input.inertia,
            loiterSeconds: input.loiterSeconds,
            enabled: input.enabled
        },
        select: SELECT
    });
    return toView(row);
}

export async function updateCameraZone(
    installedAppId: string,
    cameraId: string,
    id: string,
    input: CameraZoneInput
): Promise<CameraZoneView> {
    const existing = await prisma.cameraZone.findFirst({
        where: { id, cameraId, camera: { installedAppId } },
        select: { id: true }
    });
    if (!existing) throw new Error("Area not found");
    const row = await prisma.cameraZone.update({
        where: { id },
        data: {
            name: input.name,
            kind: input.kind,
            points: serializeZonePoints(input.points.map(([x, y]) => ({ x, y }))),
            objects: JSON.stringify(input.objects),
            inertia: input.inertia,
            loiterSeconds: input.loiterSeconds,
            enabled: input.enabled
        },
        select: SELECT
    });
    return toView(row);
}

/** Remove a zone. The events that named it keep the name they recorded: what a
 *  camera saw last week did not stop being true because the outline was redrawn
 *  this morning. */
export async function deleteCameraZone(installedAppId: string, cameraId: string, id: string): Promise<void> {
    const existing = await prisma.cameraZone.findFirst({
        where: { id, cameraId, camera: { installedAppId } },
        select: { id: true }
    });
    if (!existing) throw new Error("Area not found");
    await prisma.cameraZone.delete({ where: { id } });
}
