/**
 * The places cameras are in: a house, an office, a workshop, a site.
 *
 * One place is what somebody starts with, and it is not what they have for long
 * - a flat and a parents' house, an office and the warehouse behind it. Making
 * it a real thing rather than a field on a camera is what lets the rest of the
 * app be about one place at a time: the wall, the events, the alerts and who may
 * see any of it all mean something different at the office than at home.
 *
 * Nothing here is authorization, and a place is not an organization. Those say
 * whose work something is; this says where a camera physically points, which
 * somebody with a single account still has more than one answer to.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "@/lib/home/home-error";

import { PLACE_KINDS, type PlaceView } from "@/lib/home/place-kinds";

// Re-exported so server code has one import for "places"; the browser reaches
// for the pure module directly.
export { PLACE_KINDS, PLACE_KIND_LABELS, type PlaceKind, type PlaceView } from "@/lib/home/place-kinds";

/** What the first place is called when Polaris has to invent one. */
const FIRST_PLACE = "Home";

/**
 * Every place, with the first one created if there are none.
 *
 * Creating on read rather than at install: an install has no idea whether
 * anybody will ever add a camera, and a house that exists before the first
 * camera is a row somebody has to look at and wonder about. The moment anything
 * asks for the list, there is one.
 *
 * Cameras added before places existed are adopted here, into the first place.
 * That repair belongs on this path and nowhere else - it is the one place that
 * knows both that a camera has no place and which place it should have.
 */
export async function listPlaces(installedAppId: string): Promise<PlaceView[]> {
    const rows = await prisma.place.findMany({
        where: { installedAppId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true, address: true, _count: { select: { cameras: true } } }
    });

    const places = rows.length > 0 ? rows : [await createFirstPlace(installedAppId)];
    const first = places[0];
    if (first) {
        // A camera set up before this existed keeps working and turns up where
        // somebody would look for it, rather than vanishing from a list that now
        // filters by something it does not have.
        const adopted = await prisma.camera.updateMany({
            where: { installedAppId, placeId: null },
            data: { placeId: first.id }
        });
        if (adopted.count > 0) return listPlaces(installedAppId);
    }

    return places.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        address: row.address ?? "",
        cameras: row._count.cameras
    }));
}

/**
 * The list, cut down to what somebody was actually lent.
 *
 * A place carries the street address of a property, so the switcher is not a
 * harmless list: handing the whole one to somebody lent a single door tells them
 * where every other property in the deployment is. This answers with the places
 * that hold something they reach, and with the camera count of that much of it
 * rather than of the whole place.
 */
export async function placesHolding(
    installedAppId: string,
    all: readonly PlaceView[],
    cameraIds: readonly string[],
    deviceIds: readonly string[]
): Promise<PlaceView[]> {
    if (cameraIds.length === 0 && deviceIds.length === 0) return [];
    const [cameras, devices] = await Promise.all([
        cameraIds.length > 0
            ? prisma.camera.findMany({
                  where: { installedAppId, id: { in: [...cameraIds] } },
                  select: { placeId: true }
              })
            : [],
        deviceIds.length > 0
            ? prisma.placeDevice.findMany({
                  where: { installedAppId, id: { in: [...deviceIds] } },
                  select: { placeId: true }
              })
            : []
    ]);
    const seen = new Map<string, number>();
    // A camera or a door that is in no place yet is listed under whichever place
    // is being looked at, so the first one is where its holder finds it. Without
    // this a visitor lent an unplaced door is shown no place at all, and then
    // cannot choose the one their door is drawn in.
    const first = all[0];
    for (const row of cameras) {
        const placeId = row.placeId ?? first?.id;
        if (placeId) seen.set(placeId, (seen.get(placeId) ?? 0) + 1);
    }
    for (const row of devices) {
        const placeId = row.placeId ?? first?.id;
        if (placeId && !seen.has(placeId)) seen.set(placeId, 0);
    }
    return all
        .filter((place) => seen.has(place.id))
        .map((place) => ({ ...place, cameras: seen.get(place.id) ?? 0 }));
}

async function createFirstPlace(installedAppId: string) {
    const created = await prisma.place.create({
        data: { installedAppId, name: FIRST_PLACE, kind: "house" },
        select: { id: true, name: true, kind: true, address: true, _count: { select: { cameras: true } } }
    });
    return created;
}

/** One place of this house, or null. Scoped by the install: an id from somewhere
 *  else must not resolve. */
export async function getPlace(installedAppId: string, id: string): Promise<PlaceView | null> {
    const row = await prisma.place.findFirst({
        where: { id, installedAppId },
        select: { id: true, name: true, kind: true, address: true, _count: { select: { cameras: true } } }
    });
    return row
        ? { id: row.id, name: row.name, kind: row.kind, address: row.address ?? "", cameras: row._count.cameras }
        : null;
}

export interface PlaceInput {
    readonly name: string;
    readonly kind: string;
    readonly address: string;
}

export async function createPlace(installedAppId: string, input: PlaceInput): Promise<PlaceView> {
    const name = input.name.trim();
    if (!name) throw new HomeError("Give it a name");
    const kind = (PLACE_KINDS as readonly string[]).includes(input.kind) ? input.kind : "other";
    const row = await prisma.place.create({
        data: { installedAppId, name, kind, address: input.address.trim() || null }
    });
    return { id: row.id, name: row.name, kind: row.kind, address: row.address ?? "", cameras: 0 };
}

export async function updatePlace(installedAppId: string, id: string, input: PlaceInput): Promise<PlaceView> {
    const existing = await prisma.place.findFirst({ where: { id, installedAppId }, select: { id: true } });
    if (!existing) throw new HomeError("Place not found");
    const name = input.name.trim();
    if (!name) throw new HomeError("Give it a name");
    const kind = (PLACE_KINDS as readonly string[]).includes(input.kind) ? input.kind : "other";
    const row = await prisma.place.update({
        where: { id },
        data: { name, kind, address: input.address.trim() || null },
        select: { id: true, name: true, kind: true, address: true, _count: { select: { cameras: true } } }
    });
    return { id: row.id, name: row.name, kind: row.kind, address: row.address ?? "", cameras: row._count.cameras };
}

/**
 * Remove a place.
 *
 * Refused while anything is in it. Deleting a place could reasonably mean "and
 * everything in it" or "and put its cameras somewhere else", and a button that
 * silently picks one of those is how somebody loses four cameras and their
 * footage. Emptying it first is one more step and states which was meant.
 */
export async function deletePlace(installedAppId: string, id: string): Promise<void> {
    const place = await prisma.place.findFirst({
        where: { id, installedAppId },
        select: { id: true, _count: { select: { cameras: true } } }
    });
    if (!place) throw new HomeError("Place not found");
    if (place._count.cameras > 0) {
        throw new HomeError("Move or remove its cameras first");
    }
    const remaining = await prisma.place.count({ where: { installedAppId } });
    if (remaining <= 1) throw new HomeError("There has to be somewhere for cameras to be");
    await prisma.place.delete({ where: { id } });
}
