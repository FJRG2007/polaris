/**
 * The same device, reached a second way: moved, not listed twice.
 *
 * A house that switches how it reaches a make - a Tuya cloud project whose trial
 * ran out, replaced by the Smart Life app's QR sign-in - gets the same devices
 * back under the new connection. Each is the same row moved onto it, id kept, so
 * its name, room, labels, automations, shares and history all still point at it.
 *
 * Matched only on an id the make itself issues, and only between connections that
 * declare the same `identity` (`device-connections`): Tuya's device id is the one
 * its developer API and its device-sharing API (`tuya-device-sharing-sdk`, which
 * Home Assistant's Tuya integration moved to while keeping every entity's
 * `tuya.<device id>` unique id) both answer with. Never on a name, and never on an
 * id that only means something on one bridge.
 *
 * Only within one install, which is one owner: a device sold or left behind and
 * connected by somebody else lands on their install as a new device, and nothing
 * of the previous owner's travels with it. On the previous owner's side the
 * account simply stops listing it, which marks it gone (`devices.ts`) rather than
 * deleting it.
 */

import { prisma } from "@polaris/db";
import * as registry from "./device-connections";

/** The connections whose ids are the same make-issued ids as this one's. */
export function connectionsSharingIds(connection: string): string[] {
    const identity = registry.deviceConnection(connection)?.identity;
    if (!identity) return [];
    return registry.DEVICE_CONNECTIONS.filter((each) => each.identity === identity).map(
        (each) => each.id
    );
}

/**
 * Whether the connection now listing a device takes it from the one holding it.
 *
 * A holder that is failing always gives it up: the devices belong to the way in
 * that works. Between two that both work, the newer one wins - it is the one
 * somebody just added to replace the other - and the older never takes it back
 * while the newer keeps working, so the two never trade it on every sync.
 */
export function takesOver(
    taker: { readonly createdAt: Date },
    holder: { readonly status: string; readonly createdAt: Date }
): boolean {
    return holder.status !== "ok" || taker.createdAt.getTime() > holder.createdAt.getTime();
}

/** The history entry a move leaves, and what it is recognized by. */
export const MOVED_ACTION = "moved";
const MOVED_PREFIX = "moved:";

function movedId(from: string, to: string): string {
    return `${MOVED_PREFIX}${from}:${to}:${Date.now()}`;
}

/** `{ from, to }` of a move's history entry, or null for any other entry. */
export function readMovedId(externalId: string | null): { from: string; to: string } | null {
    if (!externalId?.startsWith(MOVED_PREFIX)) return null;
    const [from, to] = externalId.slice(MOVED_PREFIX.length).split(":");
    return from && to ? { from, to } : null;
}

/**
 * Before an account's snapshots are written: move onto it every device of this
 * install another connection with the same ids holds and gives up, and name the
 * ones it does not give up, which this sync then leaves alone instead of
 * creating a second row for.
 *
 * A device that was gone is not moved here: it comes back as an offer to restore
 * (`devices.ts`), since where it was in between is not known.
 */
export async function claimTwins(
    installedAppId: string,
    accountId: string,
    externalIds: readonly string[]
): Promise<ReadonlySet<string>> {
    const skip = new Set<string>();
    if (externalIds.length === 0) return skip;
    const taker = await prisma.placeDeviceAccount.findFirst({
        where: { id: accountId, installedAppId },
        select: { connection: true, createdAt: true }
    });
    const sharing = taker ? connectionsSharingIds(taker.connection) : [];
    if (!taker || sharing.length === 0) return skip;

    const held = await prisma.placeDevice.findMany({
        where: {
            installedAppId,
            externalId: { in: [...externalIds] },
            goneAt: null,
            accountId: { not: accountId },
            account: { connection: { in: sharing } }
        },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            externalId: true,
            accountId: true,
            account: { select: { status: true, createdAt: true, connection: true } }
        }
    });
    if (held.length === 0) return skip;
    const own = new Set(
        (
            await prisma.placeDevice.findMany({
                where: { accountId, externalId: { in: held.map((device) => device.externalId) } },
                select: { externalId: true }
            })
        ).map((device) => device.externalId)
    );

    for (const device of held) {
        // Already a row of its own here (two connections made before this
        // existed): left as it is rather than merged.
        if (own.has(device.externalId) || !device.account || !device.accountId) continue;
        if (!takesOver(taker, device.account)) {
            skip.add(device.externalId);
            continue;
        }
        // Conditional on where it still is, so two syncs racing move it once; a
        // row that appeared here meanwhile makes the unique key refuse it.
        const moved = await prisma.placeDevice
            .updateMany({
                where: { id: device.id, accountId: device.accountId },
                data: { accountId }
            })
            .catch(() => ({ count: 0 }));
        if (moved.count === 0) continue;
        own.add(device.externalId);
        await prisma.placeDeviceEvent.create({
            data: {
                deviceId: device.id,
                externalId: movedId(device.accountId, accountId),
                action: MOVED_ACTION,
                via: "system",
                note: registry.deviceConnection(device.account.connection)?.label ?? "",
                at: new Date()
            }
        });
    }
    return skip;
}

/** How long a move is reported on the screen. */
const SHOWN_FOR_MS = 14 * 24 * 60 * 60 * 1000;
const SHOWN_CEILING = 500;

export interface Handover {
    /** The account the devices moved from, and the one they moved to. */
    readonly from: string;
    readonly to: string;
    readonly count: number;
}

/** The moves of the last two weeks, one entry per pair of connections, counting
 *  the devices still where they moved to. */
export async function recentHandovers(installedAppId: string): Promise<Handover[]> {
    const entries = await prisma.placeDeviceEvent.findMany({
        where: {
            action: MOVED_ACTION,
            at: { gte: new Date(Date.now() - SHOWN_FOR_MS) },
            device: { installedAppId }
        },
        orderBy: { at: "desc" },
        take: SHOWN_CEILING,
        select: { externalId: true, deviceId: true, device: { select: { accountId: true } } }
    });
    const pairs = new Map<string, { from: string; to: string; devices: Set<string> }>();
    const placed = new Set<string>();
    for (const entry of entries) {
        // Newest first: a device that moved twice counts only for its last move.
        if (placed.has(entry.deviceId)) continue;
        placed.add(entry.deviceId);
        const moved = readMovedId(entry.externalId);
        if (!moved || entry.device.accountId !== moved.to) continue;
        const key = `${moved.from}>${moved.to}`;
        const pair = pairs.get(key) ?? { ...moved, devices: new Set<string>() };
        pair.devices.add(entry.deviceId);
        pairs.set(key, pair);
    }
    return [...pairs.values()].map(({ from, to, devices }) => ({ from, to, count: devices.size }));
}
