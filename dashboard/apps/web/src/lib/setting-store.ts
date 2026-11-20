/**
 * Read/write access to the `Setting` key/value table for the domain configuration
 * modules, with the upsert/delete semantics they share (writing null forgets the key
 * rather than storing an empty string). Older modules still carry their own copy of
 * these two helpers; new configuration code uses this one.
 */

import { prisma } from "@polaris/db";
import { coalescer } from "@/lib/coalesce";

// Every screen reads a few of these, so a burst of page loads asks for the same
// keys at once. Shared only while in flight - never kept - and dropped on every
// write here, so an ask that starts after a write never joins a read from before it.
const singleReads = coalescer<string | null>();
const groupReads = coalescer<Map<string, string>>();

/**
 * Drop the reads in flight, after a write that did not go through this module.
 * Only needed where the same flow reads the key back right after writing it.
 */
export function forgetSettingReads(): void {
    singleReads.forget();
    groupReads.forget();
}

/** The stored value for a key, or null when unset. */
export async function getSetting(key: string): Promise<string | null> {
    return singleReads.run(key, async () => {
        const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
        return row?.value ?? null;
    });
}

/** Several keys in one query; an unset key is absent from the map. */
export async function getSettings(keys: readonly string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const shared = await groupReads.run(JSON.stringify([...new Set(keys)].sort()), async () => {
        const rows = await prisma.setting.findMany({
            where: { key: { in: [...keys] } },
            select: { key: true, value: true }
        });
        return new Map(rows.map((row) => [row.key, row.value]));
    });
    // A copy each, since the map is the caller's to change.
    return new Map(shared);
}

/** Store a value, or forget the key when null. */
export async function setSetting(key: string, value: string | null): Promise<void> {
    try {
        if (value === null) {
            await prisma.setting.deleteMany({ where: { key } });
            return;
        }
        await prisma.setting.upsert({
            where: { key },
            create: { key, value, scope: "global" },
            update: { value }
        });
    } finally {
        forgetSettingReads();
    }
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
    try {
        return await swap(key, expected, value);
    } finally {
        forgetSettingReads();
    }
}

async function swap(key: string, expected: string | null, value: string): Promise<boolean> {
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
