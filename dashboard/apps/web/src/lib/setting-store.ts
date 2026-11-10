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
    await prisma.setting.upsert({
        where: { key },
        create: { key, value, scope: "global" },
        update: { value }
    });
}

/**
 * Store a value only if the key still holds `expected` (null: only if unset), and
 * answer whether it did. Whoever loses a race reads again, so a count kept here
 * loses nothing to two writers at once.
 */
export async function swapSetting(
    key: string,
    expected: string | null,
    value: string
): Promise<boolean> {
    if (expected === null) {
        // A plain create and its unique-key refusal, rather than `createMany` with
        // `skipDuplicates`: SQLite, which a local Polaris runs on, has no such
        // option and refuses the whole call, so every first claim failed there.
        try {
            await prisma.setting.create({ data: { key, value, scope: "global" }, select: { key: true } });
            return true;
        } catch (caught) {
            if ((caught as { code?: string } | null)?.code === "P2002") return false;
            throw caught;
        }
    }
    const { count } = await prisma.setting.updateMany({
        where: { key, value: expected },
        data: { value }
    });
    return count === 1;
}
