/**
 * Wall panels: grids of cards somebody arranged for a screen on the wall. A
 * panel belongs to one place and names that place's devices and rooms; one
 * removed later is skipped when the panel is drawn, so nothing has to follow a
 * deletion.
 *
 * Handed out as a link (`place.panel`), a panel is a key to exactly what it
 * shows: `panelHolds` is the one answer to "is this device on it", read again
 * for every press, so a card taken off stops being reachable at once.
 *
 * The same holds for its cameras and its automation buttons: a link watches
 * only the cameras on the panel (`panelHoldsCamera`) and starts only the
 * automations it has a button for (`panelHoldsAutomation`).
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as devices from "./devices";
import { host } from "@polaris/app-host";
import { getCamerasAt, type CameraView } from "./cameras";
import { HomeError } from "./home-error";
import type { DeviceView } from "./device-kinds";
import {
    PANELS_PER_PLACE,
    panelAutomationIds,
    panelCameraIds,
    panelDeviceIds,
    panelDirectDeviceIds,
    panelRoomIds,
    storedCards,
    type PanelCard,
    type PanelView
} from "./panel-layout";

const FIELDS = { id: true, placeId: true, name: true, cards: true } as const;

function toView(row: { id: string; placeId: string; name: string; cards: unknown }): PanelView {
    return { id: row.id, placeId: row.placeId, name: row.name, cards: storedCards(row.cards) };
}

/** Every panel of a place, by name. */
export async function listPanels(installedAppId: string, placeId: string): Promise<PanelView[]> {
    const rows = await prisma.placePanel.findMany({
        where: { installedAppId, placeId },
        select: FIELDS,
        orderBy: { name: "asc" },
        take: PANELS_PER_PLACE
    });
    return rows.map(toView);
}

export async function requirePanel(installedAppId: string, id: string): Promise<PanelView> {
    const row = await prisma.placePanel.findFirst({
        where: { id, installedAppId },
        select: FIELDS
    });
    if (!row) throw new HomeError("That panel is not here");
    return toView(row);
}

export async function createPanel(
    installedAppId: string,
    placeId: string,
    name: string
): Promise<PanelView> {
    const place = await prisma.place.findFirst({
        where: { id: placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    const count = await prisma.placePanel.count({ where: { installedAppId, placeId } });
    if (count >= PANELS_PER_PLACE) throw new HomeError("A place holds up to 20 panels");
    const row = await prisma.placePanel.create({
        data: { installedAppId, placeId, name, cards: [] },
        select: FIELDS
    });
    return toView(row);
}

export async function renamePanel(
    installedAppId: string,
    id: string,
    name: string
): Promise<PanelView> {
    await requirePanel(installedAppId, id);
    const row = await prisma.placePanel.update({ where: { id }, data: { name }, select: FIELDS });
    return toView(row);
}

/**
 * A panel's cards, saved whole. Every device and room a card names must be
 * this install's and at the panel's place (a device not placed anywhere yet
 * counts as here, as on the devices screen): a panel link must never be made
 * into a key to another place's door by naming it on a card.
 */
export async function savePanelCards(
    installedAppId: string,
    id: string,
    cards: readonly PanelCard[]
): Promise<PanelView> {
    const panel = await requirePanel(installedAppId, id);
    const deviceIds = panelDirectDeviceIds(cards);
    const roomIds = panelRoomIds(cards);
    const cameraIds = panelCameraIds(cards);
    const automationIds = panelAutomationIds(cards);
    const [foundDevices, foundRooms, foundCameras, foundAutomations] = await Promise.all([
        deviceIds.length
            ? prisma.placeDevice.count({
                  where: {
                      installedAppId,
                      id: { in: deviceIds },
                      OR: [{ placeId: panel.placeId }, { placeId: null }]
                  }
              })
            : 0,
        roomIds.length
            ? prisma.placeRoom.count({
                  where: { installedAppId, placeId: panel.placeId, id: { in: roomIds } }
              })
            : 0,
        cameraIds.length
            ? prisma.camera.count({
                  where: {
                      installedAppId,
                      id: { in: cameraIds },
                      OR: [{ placeId: panel.placeId }, { placeId: null }]
                  }
              })
            : 0,
        automationIds.length
            ? prisma.placeAutomation.count({
                  where: { installedAppId, placeId: panel.placeId, id: { in: automationIds } }
              })
            : 0
    ]);
    if (
        foundDevices !== deviceIds.length ||
        foundRooms !== roomIds.length ||
        foundCameras !== cameraIds.length ||
        foundAutomations !== automationIds.length
    ) {
        throw new HomeError("A card on that panel is not at this place");
    }
    const row = await prisma.placePanel.update({
        where: { id },
        data: { cards: cards as unknown as object[] },
        select: FIELDS
    });
    return toView(row);
}

export async function deletePanel(installedAppId: string, id: string): Promise<void> {
    const { count } = await prisma.placePanel.deleteMany({ where: { id, installedAppId } });
    if (count === 0) throw new HomeError("That panel is not here");
    await host.accessGrants.dropGrantsFor("place.panel", id);
}

/** Which devices each of these rooms holds now, at the panel's place. */
async function devicesInRooms(
    installedAppId: string,
    placeId: string,
    roomIds: readonly string[]
): Promise<Map<string, string[]>> {
    const byRoom = new Map<string, string[]>();
    if (roomIds.length === 0) return byRoom;
    const rows = await prisma.placeDevice.findMany({
        where: { installedAppId, placeId, roomId: { in: [...roomIds] } },
        select: { id: true, roomId: true },
        orderBy: { name: "asc" },
        take: 2000
    });
    for (const row of rows) {
        if (!row.roomId) continue;
        byRoom.set(row.roomId, [...(byRoom.get(row.roomId) ?? []), row.id]);
    }
    return byRoom;
}

/** Everything one panel draws, read now. */
export interface PanelContents {
    readonly panel: PanelView;
    /** Every device on its cards, once each. */
    readonly devices: readonly DeviceView[];
    /** Each room card's room: its name and the devices in it now. */
    readonly rooms: readonly { id: string; name: string; deviceIds: readonly string[] }[];
    /** Each camera card's camera, still at the panel's place. */
    readonly cameras: readonly CameraView[];
    /** Each button's automation, still at the panel's place. */
    readonly automations: readonly PanelAutomation[];
}

/** What a button shows of the automation it runs. */
export interface PanelAutomation {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
}

/** The cameras on these cards still at the place (or placed nowhere yet). */
async function camerasHere(
    installedAppId: string,
    placeId: string,
    cards: readonly PanelCard[]
): Promise<CameraView[]> {
    return getCamerasAt(installedAppId, placeId, panelCameraIds(cards));
}

async function automationsHere(
    installedAppId: string,
    placeId: string,
    cards: readonly PanelCard[]
): Promise<PanelAutomation[]> {
    const ids = panelAutomationIds(cards);
    if (ids.length === 0) return [];
    return prisma.placeAutomation.findMany({
        where: { installedAppId, placeId, id: { in: ids } },
        select: { id: true, name: true, enabled: true }
    });
}

export async function panelContents(installedAppId: string, id: string): Promise<PanelContents> {
    const panel = await requirePanel(installedAppId, id);
    const roomIds = panelRoomIds(panel.cards);
    const [byRoom, roomRows, cameras, automations] = await Promise.all([
        devicesInRooms(installedAppId, panel.placeId, roomIds),
        roomIds.length
            ? prisma.placeRoom.findMany({
                  where: { installedAppId, placeId: panel.placeId, id: { in: roomIds } },
                  select: { id: true, name: true }
              })
            : [],
        camerasHere(installedAppId, panel.placeId, panel.cards),
        automationsHere(installedAppId, panel.placeId, panel.cards)
    ]);
    const ids = panelDeviceIds(panel.cards, byRoom);
    const all = ids.size ? await devices.listDevices(installedAppId, panel.placeId) : [];
    return {
        panel,
        devices: all.filter((device) => ids.has(device.id)),
        rooms: roomRows.map((room: { id: string; name: string }) => ({
            id: room.id,
            name: room.name,
            deviceIds: byRoom.get(room.id) ?? []
        })),
        cameras,
        automations
    };
}

/** The devices a panel reaches right now - what its link may see and press. */
export async function panelReach(installedAppId: string, id: string): Promise<Set<string>> {
    return (await panelPlaceReach(installedAppId, id))?.devices ?? new Set();
}

/** A panel's place and the devices it reaches now, or null when it is gone. */
export async function panelPlaceReach(
    installedAppId: string,
    id: string
): Promise<{ placeId: string; devices: Set<string> } | null> {
    const row = await prisma.placePanel.findFirst({
        where: { id, installedAppId },
        select: { placeId: true, cards: true }
    });
    if (!row) return null;
    const cards = storedCards(row.cards);
    const byRoom = await devicesInRooms(installedAppId, row.placeId, panelRoomIds(cards));
    const ids = panelDeviceIds(cards, byRoom);
    // A device card only reaches a device still at the panel's place (or
    // placed nowhere): moving a door to another place takes it off the link.
    const direct = panelDirectDeviceIds(cards);
    if (direct.length) {
        const here = await prisma.placeDevice.findMany({
            where: {
                installedAppId,
                id: { in: direct },
                OR: [{ placeId: row.placeId }, { placeId: null }]
            },
            select: { id: true }
        });
        const kept = new Set(here.map((device: { id: string }) => device.id));
        for (const deviceId of direct) {
            if (
                !kept.has(deviceId) &&
                ![...byRoom.values()].some((list) => list.includes(deviceId))
            )
                ids.delete(deviceId);
        }
    }
    return { placeId: row.placeId, devices: ids };
}

/** Whether a device is on this panel now. */
export async function panelHolds(
    installedAppId: string,
    panelId: string,
    deviceId: string
): Promise<boolean> {
    return (await panelReach(installedAppId, panelId)).has(deviceId);
}

async function panelRow(installedAppId: string, id: string) {
    const row = await prisma.placePanel.findFirst({
        where: { id, installedAppId },
        select: { placeId: true, cards: true }
    });
    return row ? { placeId: row.placeId, cards: storedCards(row.cards) } : null;
}

/** The automations of a place a button can be made for, by name. */
export async function automationChoices(
    installedAppId: string,
    placeId: string
): Promise<PanelAutomation[]> {
    return prisma.placeAutomation.findMany({
        where: { installedAppId, placeId },
        select: { id: true, name: true, enabled: true },
        orderBy: { name: "asc" },
        take: 500
    });
}

/** Whether a camera is on this panel now, and still at the panel's place. */
export async function panelHoldsCamera(
    installedAppId: string,
    panelId: string,
    cameraId: string
): Promise<boolean> {
    const row = await panelRow(installedAppId, panelId);
    if (!row || !panelCameraIds(row.cards).includes(cameraId)) return false;
    const found = await prisma.camera.count({
        where: {
            installedAppId,
            id: cameraId,
            OR: [{ placeId: row.placeId }, { placeId: null }]
        }
    });
    return found > 0;
}

/** Whether this panel has a button for an automation now, at its own place. */
export async function panelHoldsAutomation(
    installedAppId: string,
    panelId: string,
    automationId: string
): Promise<boolean> {
    const row = await panelRow(installedAppId, panelId);
    if (!row || !panelAutomationIds(row.cards).includes(automationId)) return false;
    const found = await prisma.placeAutomation.count({
        where: { installedAppId, placeId: row.placeId, id: automationId }
    });
    return found > 0;
}

/** Where a panel is, for a fence on its link. */
export async function panelPlaceId(installedAppId: string, id: string): Promise<string | null> {
    return (await panelRow(installedAppId, id))?.placeId ?? null;
}
