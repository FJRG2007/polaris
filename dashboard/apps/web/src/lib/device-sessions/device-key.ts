/**
 * The per-account key a claimed device id becomes, and the one question the
 * sign-in paths ask of it: is this device blocked. Kept apart from
 * `./device-block` so the session guard, the device sign-in and the API key
 * check import nothing but the database for it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { DEVICE_ID_HEADER, DEVICE_NAME_HEADER, readDeviceId, readDeviceName } from "@polaris/core";

/** The per-account key for a claimed device id, or null when there is no
 *  well-formed claim. */
export function deviceKeyFor(userId: string, claim: string | null | undefined): string | null {
    const id = readDeviceId(claim);
    if (!id) return null;
    return createHash("sha256").update(`${userId}\u0000${id}`).digest("hex");
}

/** The device a request claims through Polaris Desktop's headers. Nulls when it
 *  claims none, or outside a request. */
export async function requestDeviceClaim(): Promise<{ id: string | null; name: string | null }> {
    try {
        const sent = await headers();
        return {
            id: readDeviceId(sent.get(DEVICE_ID_HEADER)),
            name: readDeviceName(sent.get(DEVICE_NAME_HEADER), true)
        };
    } catch {
        return { id: null, name: null };
    }
}

/** A device key as a caller hands it back: the same shape `deviceKeyFor` makes. */
export const DEVICE_KEY_PATTERN = /^[a-f0-9]{64}$/;

/** Whether this account blocked the device. False for a request with no key. */
export async function isDeviceBlocked(userId: string, deviceKey: string | null): Promise<boolean> {
    if (!deviceKey) return false;
    const row = await prisma.blockedDevice.findUnique({
        where: { userId_deviceKey: { userId, deviceKey } },
        select: { id: true }
    });
    return row !== null;
}
