/**
 * The labels at a place, and which devices carry them.
 *
 * A label names part of a room or the same thing across several - "Ceiling",
 * "Night lights" - so an automation can turn on all of them, or leave them out,
 * the way a room names all of what is in it. Deleting a label leaves its
 * devices where they are; a device moved to another place drops the labels of
 * the one it left.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import type { LabelView } from "./room-kinds";

export type { LabelView } from "./room-kinds";

const FIELDS = { id: true, placeId: true, name: true } as const;

/** The most labels one place keeps, and one device carries. */
export const LABEL_LIMITS = { perPlace: 100, perDevice: 20 } as const;

/** A place's labels, or several places', by name. */
export async function listLabels(
    installedAppId: string,
    placeId: string | readonly string[]
): Promise<LabelView[]> {
    const ids = typeof placeId === "string" ? [placeId] : [...placeId];
    if (ids.length === 0) return [];
    return prisma.placeLabel.findMany({
        where: { installedAppId, placeId: ids.length === 1 ? ids[0] : { in: ids } },
        orderBy: { name: "asc" },
        select: FIELDS,
        take: LABEL_LIMITS.perPlace * ids.length
    });
}

async function requireLabel(installedAppId: string, id: string): Promise<LabelView> {
    const row = await prisma.placeLabel.findFirst({
        where: { id, installedAppId },
        select: FIELDS
    });
    if (!row) throw new HomeError("Label not found");
    return row;
}

/** A label write, refusing a second label of the same name at the place. */
async function labelWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (caught) {
        if ((caught as { code?: string } | null)?.code === "P2002")
            throw new HomeError("A label with that name is already here");
        throw caught;
    }
}

export async function createLabel(
    installedAppId: string,
    input: { placeId: string; name: string }
): Promise<LabelView> {
    const place = await prisma.place.findFirst({
        where: { id: input.placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    const count = await prisma.placeLabel.count({ where: { placeId: place.id } });
    if (count >= LABEL_LIMITS.perPlace) throw new HomeError("This place has all the labels it can");
    return labelWrite(() =>
        prisma.placeLabel.create({
            data: { installedAppId, placeId: place.id, name: input.name },
            select: FIELDS
        })
    );
}

export async function renameLabel(
    installedAppId: string,
    id: string,
    name: string
): Promise<LabelView> {
    await requireLabel(installedAppId, id);
    return labelWrite(() =>
        prisma.placeLabel.update({ where: { id }, data: { name }, select: FIELDS })
    );
}

/** Remove a label. Its devices stay as they are, without it. */
export async function deleteLabel(installedAppId: string, id: string): Promise<void> {
    await requireLabel(installedAppId, id);
    await prisma.placeLabel.delete({ where: { id } });
}

/**
 * Set the labels a device carries to exactly these, each one of its place's.
 * Run inside the device's own write so a device and its labels never disagree.
 */
export async function setDeviceLabels(
    tx: Pick<typeof prisma, "placeLabel" | "placeDeviceLabel">,
    installedAppId: string,
    deviceId: string,
    placeId: string | null,
    labelIds: readonly string[]
): Promise<void> {
    const wanted = [...new Set(labelIds)];
    const found = placeId
        ? await tx.placeLabel.findMany({
              where: { id: { in: wanted }, installedAppId, placeId },
              select: { id: true }
          })
        : [];
    if (found.length !== wanted.length) throw new HomeError("That label is at another place");
    await tx.placeDeviceLabel.deleteMany({ where: { deviceId, labelId: { notIn: wanted } } });
    if (wanted.length > 0)
        await tx.placeDeviceLabel.createMany({
            data: wanted.map((labelId) => ({ deviceId, labelId })),
            skipDuplicates: true
        });
}

/** Drop the labels a device carries that are not its place's. */
export async function dropForeignLabels(
    tx: Pick<typeof prisma, "placeDeviceLabel">,
    deviceId: string,
    placeId: string | null
): Promise<void> {
    await tx.placeDeviceLabel.deleteMany({
        where: { deviceId, ...(placeId ? { label: { placeId: { not: placeId } } } : {}) }
    });
}
