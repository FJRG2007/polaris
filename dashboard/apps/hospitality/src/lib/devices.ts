/**
 * Devices linked to a venue: starting a link, approving it, collecting the
 * token, and the admin's list (rename, revoke, last seen).
 *
 * Only hashes are stored - of the device's secret while the link is being
 * made, and of its token after - so a copy of the database links nothing. The
 * token is made once, handed over once (on the poll that collects it) and
 * compared by hash. A device is scoped to one venue; what it may do there is
 * decided by `outcome()`, never by the device.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HospitalityRefusal } from "./outcome";
import { createHash, randomBytes } from "node:crypto";
import { LINK_TTL_MS, SEEN_EVERY_MS, normalizeUserCode, pollAnswer, userCodeFrom, type PollAnswer } from "../model/device-link";

export function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
    return randomBytes(32).toString("base64url");
}

function newUserCode(): string {
    for (;;) {
        const code = userCodeFrom(randomBytes(32));
        if (code) return code;
    }
}

/** A device asks to be linked: it keeps `deviceCode` and shows `userCode`. */
export async function startLink(): Promise<{ deviceCode: string; userCode: string; expiresAt: string }> {
    // Codes nobody approved in time are of no use to anyone.
    await prisma.hospitalityDeviceLink.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const deviceCode = newSecret();
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    for (let attempt = 0; ; attempt++) {
        const userCode = newUserCode();
        try {
            await prisma.hospitalityDeviceLink.create({ data: { userCode, deviceCodeHash: hashSecret(deviceCode), expiresAt } });
            return { deviceCode, userCode, expiresAt: expiresAt.toISOString() };
        } catch (error) {
            // A clash on the unique code is retried; anything else is not ours to hide.
            if (attempt >= 3 || (error as { code?: string }).code !== "P2002") throw error;
        }
    }
}

/** The venue's admin approves a code they read off the device or scanned. */
export async function approveLink(input: { userCode: string; venueId: string; name: string }, actorId: string): Promise<void> {
    const userCode = normalizeUserCode(input.userCode);
    if (!userCode) throw new HospitalityRefusal("devices.badCode");
    const venue = await prisma.hospitalityVenue.findUnique({ where: { id: input.venueId }, select: { id: true } });
    if (!venue) throw new HospitalityRefusal("devices.badCode");
    const approved = await prisma.hospitalityDeviceLink.updateMany({
        where: { userCode, approvedAt: null, deviceId: null, expiresAt: { gt: new Date() } },
        data: { approvedAt: new Date(), approvedById: actorId, venueId: venue.id, name: input.name }
    });
    if (approved.count === 0) throw new HospitalityRefusal("devices.badCode");
}

/**
 * The device asks whether it was approved. The first poll after approval
 * makes the device and its token, inside one transaction that also marks the
 * link used, so two racing polls cannot both collect one.
 */
export async function pollLink(deviceCode: string): Promise<{ answer: PollAnswer; token?: string; deviceId?: string; venueId?: string }> {
    const link = await prisma.hospitalityDeviceLink.findUnique({ where: { deviceCodeHash: hashSecret(deviceCode) } });
    if (!link) return { answer: "expired" };
    const now = new Date();
    const answer = pollAnswer(link, now);
    if (answer !== "approved" || !link.venueId) {
        if (answer === "pending") await prisma.hospitalityDeviceLink.update({ where: { id: link.id }, data: { lastPolledAt: now } });
        return { answer };
    }
    const venueId = link.venueId;
    const token = newSecret();
    const device = await prisma.$transaction(async (tx) => {
        const made = await tx.hospitalityDevice.create({
            data: { venueId, name: link.name, tokenHash: hashSecret(token), createdById: link.approvedById, lastSeenAt: now },
            select: { id: true }
        });
        const claimed = await tx.hospitalityDeviceLink.updateMany({ where: { id: link.id, deviceId: null }, data: { deviceId: made.id } });
        if (claimed.count === 0) throw new HospitalityRefusal("devices.badCode");
        return made;
    });
    return { answer: "approved", token, deviceId: device.id, venueId };
}

/** The device a token belongs to, if it is still linked. Marks it seen, at most once a minute. */
export async function deviceFromToken(token: string): Promise<{ id: string; name: string; venueId: string } | null> {
    if (!token || token.length > 200) return null;
    const device = await prisma.hospitalityDevice.findUnique({
        where: { tokenHash: hashSecret(token) },
        select: { id: true, name: true, venueId: true, revokedAt: true, lastSeenAt: true }
    });
    if (!device || device.revokedAt) return null;
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > SEEN_EVERY_MS) {
        await prisma.hospitalityDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    return { id: device.id, name: device.name, venueId: device.venueId };
}

export interface DeviceView {
    readonly id: string;
    readonly name: string;
    readonly lastSeenAt: string | null;
    readonly createdAt: string;
}

export async function listDevices(venueId: string): Promise<DeviceView[]> {
    const rows = await prisma.hospitalityDevice.findMany({
        where: { venueId, revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, lastSeenAt: true, createdAt: true },
        take: 500
    });
    return rows.map((d) => ({ id: d.id, name: d.name, lastSeenAt: d.lastSeenAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() }));
}

export async function renameDevice(id: string, name: string): Promise<void> {
    await prisma.hospitalityDevice.updateMany({ where: { id, revokedAt: null }, data: { name } });
}

/** Revoked at once: its next request is refused, and nothing it queued offline is accepted. */
export async function revokeDevice(id: string): Promise<void> {
    await prisma.hospitalityDevice.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}
