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
import { listUserSessions } from "@/lib/session-directory";
import { listDeviceSessions } from "@/lib/device-sessions/sessions";
import { notifySessionsClosed } from "@/lib/notifications/session-events";
import { listExtensionSessions, revokeExtensionSession } from "@/lib/extension/sessions";
import { deviceMembers, groupByDevice, type DeviceGroup } from "@/lib/device-sessions/device-groups";

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

/** What one device has open, by kind: what signing it out reaches. */
export interface DeviceTargets {
    /** Every device key on it. Anything else claiming one of them - a row past
     *  the screen's page - is reached too. */
    readonly deviceKeys: readonly string[];
    readonly sessionIds: readonly string[];
    readonly deviceSessionIds: readonly string[];
    readonly extensionIds: readonly string[];
}

/**
 * One device as the sessions screen groups it, read again on the server from
 * the account's own rows - so a press names a group, and what it reaches is
 * decided here, by the same `groupByDevice` the screen drew, never by a list
 * the browser sent. Null when no such device is there any more.
 */
export async function resolveDeviceGroup(
    userId: string,
    currentSessionId: string,
    key: string
): Promise<{ group: DeviceGroup; targets: DeviceTargets } | null> {
    const [sessions, deviceSessions, extensions] = await Promise.all([
        listUserSessions(userId, currentSessionId),
        listDeviceSessions(userId),
        listExtensionSessions(userId)
    ]);
    const group = groupByDevice(deviceMembers({ sessions, deviceSessions, extensions })).find(
        (candidate) => candidate.key === key
    );
    if (!group) return null;
    const members = new Set(group.memberIds);
    const ids = (rows: readonly { readonly id: string }[]) =>
        rows.filter((row) => members.has(row.id)).map((row) => row.id);
    return {
        group,
        targets: {
            deviceKeys: group.deviceKeys,
            sessionIds: ids(sessions),
            deviceSessionIds: ids(deviceSessions),
            extensionIds: ids(extensions)
        }
    };
}

/**
 * End everything open on one device: its sessions, its device sign-ins and its
 * extension connections. The reader's own session is spared, so the press never
 * signs out the page it was made on; blocking refuses the device the reader is
 * on before it gets here. Every write is scoped to the owner.
 */
export async function signOutDevice(
    userId: string,
    targets: DeviceTargets,
    currentSessionId: string,
    label: string,
    now = new Date()
): Promise<number> {
    const keys = [...targets.deviceKeys];
    const states = keys.length
        ? await prisma.sessionState.findMany({
              where: { userId, deviceKey: { in: keys }, sessionId: { not: currentSessionId } },
              select: { sessionId: true },
              take: 500
          })
        : [];
    const sessionIds = [
        ...new Set([...targets.sessionIds, ...states.map((state) => state.sessionId)])
    ].filter((id) => id !== currentSessionId);
    const sessions = sessionIds.length
        ? await prisma.session.deleteMany({ where: { userId, id: { in: sessionIds } } })
        : { count: 0 };
    const signIns = [
        ...(keys.length ? [{ clientDeviceKey: { in: keys } }] : []),
        ...(targets.deviceSessionIds.length ? [{ id: { in: [...targets.deviceSessionIds] } }] : [])
    ];
    const apps = signIns.length
        ? await prisma.apiKey.updateMany({
              where: { userId, kind: { in: DEVICE_KINDS }, revokedAt: null, OR: signIns },
              data: { revokedAt: now }
          })
        : { count: 0 };
    let connections = 0;
    for (const id of targets.extensionIds) {
        if ((await revokeExtensionSession(userId, id, now)).revoked) connections += 1;
    }
    const count = sessions.count + apps.count + connections;
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

/** Block every key a device claimed and end everything it has open. Idempotent. */
export async function blockDevice(
    userId: string,
    targets: DeviceTargets,
    currentSessionId: string,
    label: string,
    os: string | null
): Promise<number> {
    for (const deviceKey of targets.deviceKeys) {
        await prisma.blockedDevice.upsert({
            where: { userId_deviceKey: { userId, deviceKey } },
            create: { userId, deviceKey, label, os },
            update: {}
        });
    }
    await recordAudit({ actorId: userId, action: "account.device.blocked", metadata: { device: label } });
    return signOutDevice(userId, targets, currentSessionId, label);
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
