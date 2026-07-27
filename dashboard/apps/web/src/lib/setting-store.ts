/**
 * Read/write access to the `Setting` key/value table, the store every piece of
 * instance-wide configuration uses. One place so the upsert/delete semantics
 * (writing null forgets the key rather than storing an empty string) are the same
 * everywhere and configuration modules stay free of Prisma details.
 */

import { prisma } from "@polaris/db";

/** The stored value for a key, or null when unset. */
export async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

/** Read several keys in one query, as a key -> value map (absent keys are omitted). */
export async function getSettings(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    return new Map(rows.map((row) => [row.key, row.value]));
}

/** Store a value, or forget the key when null. */
export async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}
