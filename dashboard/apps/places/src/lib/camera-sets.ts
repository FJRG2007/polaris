/**
 * Camera sets: groups of cameras somebody picked by hand, for switching privacy
 * on all of them at once ("Upstairs at night"). A set belongs to one place and
 * names only that place's cameras; a camera removed later simply stops
 * matching, so nothing has to follow a deletion.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import type { CameraSetInput, CameraSetView } from "./privacy-kinds";

const FIELDS = { id: true, placeId: true, name: true, cameraIds: true } as const;

function toView(row: {
    id: string;
    placeId: string;
    name: string;
    cameraIds: string[];
}): CameraSetView {
    return { id: row.id, placeId: row.placeId, name: row.name, cameraIds: row.cameraIds };
}

/** Every set of a place, or of the whole install when no place is named. */
export async function listCameraSets(
    installedAppId: string,
    placeId?: string
): Promise<CameraSetView[]> {
    const rows = await prisma.cameraSet.findMany({
        where: { installedAppId, ...(placeId ? { placeId } : {}) },
        select: FIELDS,
        orderBy: { name: "asc" },
        take: 200
    });
    return rows.map(toView);
}

export async function requireCameraSet(installedAppId: string, id: string): Promise<CameraSetView> {
    const row = await prisma.cameraSet.findFirst({ where: { id, installedAppId }, select: FIELDS });
    if (!row) throw new HomeError("Camera set not found");
    return toView(row);
}

/** The place must be this install's and every camera one of that place's. */
async function checked(installedAppId: string, input: CameraSetInput): Promise<void> {
    const place = await prisma.place.findFirst({
        where: { id: input.placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    const found = await prisma.camera.count({
        where: { installedAppId, placeId: input.placeId, id: { in: [...input.cameraIds] } }
    });
    if (found !== input.cameraIds.length)
        throw new HomeError("A camera in that set is not at this place");
}

/** A new set (no id), or a set's new name and cameras. */
export async function saveCameraSet(
    installedAppId: string,
    id: string | null,
    input: CameraSetInput
): Promise<CameraSetView> {
    await checked(installedAppId, input);
    const data = { placeId: input.placeId, name: input.name, cameraIds: [...input.cameraIds] };
    if (!id) {
        const row = await prisma.cameraSet.create({
            data: { installedAppId, ...data },
            select: FIELDS
        });
        return toView(row);
    }
    await requireCameraSet(installedAppId, id);
    const row = await prisma.cameraSet.update({ where: { id }, data, select: FIELDS });
    return toView(row);
}

export async function deleteCameraSet(installedAppId: string, id: string): Promise<void> {
    const { count } = await prisma.cameraSet.deleteMany({ where: { id, installedAppId } });
    if (count === 0) throw new HomeError("Camera set not found");
}
