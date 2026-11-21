/**
 * Devices as their owner sees them on Account > Sessions: the per-account key a
 * claimed device id becomes, signing every session of one device out, and
 * blocking a device so it cannot sign in again.
 *
 * **What a device key is.** A native client (Polaris Desktop, the command line,
 * the Stream Deck plugin) sends a hashed machine id (`@polaris/core`
 * `device-identity`). It is hashed again here with the account id, so the same
 * computer is a different value on every account and nothing stored here can be
 * matched across accounts.
 *
 * **What a block holds against.** Every client that reports its device: the
 * desktop's sessions (checked by the session guard on every request, so a block
 * ends one already open), and device sign-ins (refused when they are claimed,
 * and checked on every key use). A client that hides or forges its id is not
 * recognised - the id is a claim - which is why the screen calls this a block on
 * the device as it identifies itself, and why ending sessions, revoking trust
 * and changing the password remain the controls that do not depend on it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { DEVICE_KINDS } from "@/lib/device-sessions/kinds";
import { notifySessionsClosed } from "@/lib/notifications/session-events";

export { DEVICE_KEY_PATTERN } from "@/lib/device-sessions/device-key";

/** A blocked device, as the sessions screen lists it. */
export interface BlockedDeviceView {
    readonly id: string;
    readonly label: string;
    readonly os: string | null;
    readonly createdAt: string;
}

export async function listBlockedDevices(userId: string): Promise<BlockedDeviceView[]> {
    const rows = await prisma.blockedDevice.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, label: true, os: true, createdAt: true }
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/**
 * End every session and device sign-in that claims this device. The reader's
 * own session is spared, so the press never signs out the page it was made on;
 * blocking refuses the device the reader is on before it gets here.
 */
export async function signOutDevice(
    userId: string,
    deviceKey: string,
    currentSessionId: string,
    label: string,
    now = new Date()
): Promise<number> {
    const states = await prisma.sessionState.findMany({
        where: { userId, deviceKey, sessionId: { not: currentSessionId } },
        select: { sessionId: true },
        take: 500
    });
    const sessions = await prisma.session.deleteMany({
        where: { userId, id: { in: states.map((state) => state.sessionId) } }
    });
    const keys = await prisma.apiKey.updateMany({
        where: { userId, clientDeviceKey: deviceKey, kind: { in: DEVICE_KINDS }, revokedAt: null },
        data: { revokedAt: now }
    });
    const count = sessions.count + keys.count;
    if (count > 0) {
        await recordAudit({
            actorId: userId,
            action: "account.session.revoked-device",
            metadata: { count, device: label }
        });
        await notifySessionsClosed({ userId, count, reason: `Everything open on ${label}.` });
    }
    return count;
}

/** Block a device and end everything it has open. Idempotent. */
export async function blockDevice(
    userId: string,
    deviceKey: string,
    currentSessionId: string,
    label: string,
    os: string | null
): Promise<number> {
    await prisma.blockedDevice.upsert({
        where: { userId_deviceKey: { userId, deviceKey } },
        create: { userId, deviceKey, label, os },
        update: {}
    });
    await recordAudit({ actorId: userId, action: "account.device.blocked", metadata: { device: label } });
    return signOutDevice(userId, deviceKey, currentSessionId, label);
}

/** Lift a block. Scoped to the owner, so another account's id changes nothing. */
export async function unblockDevice(userId: string, id: string): Promise<boolean> {
    const row = await prisma.blockedDevice.findFirst({
        where: { id, userId },
        select: { id: true, label: true }
    });
    if (!row) return false;
    await prisma.blockedDevice.deleteMany({ where: { id: row.id, userId } });
    await recordAudit({
        actorId: userId,
        action: "account.device.unblocked",
        metadata: { device: row.label }
    });
    return true;
}
