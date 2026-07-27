/**
 * Read/write access to the `Setting` key/value table for the domain configuration
 * modules, with the upsert/delete semantics they share (writing null forgets the key
 * rather than storing an empty string). Older modules still carry their own copy of
 * these two helpers; new configuration code uses this one.
 */

import { prisma } from "@polaris/db";

/** The stored value for a key, or null when unset. */
export async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

/** Store a value, or forget the key when null. */
export async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}
