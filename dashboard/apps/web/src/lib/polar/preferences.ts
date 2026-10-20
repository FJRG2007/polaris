/**
 * Polar's per-person settings as one row: memory on or off, and what a chat
 * shows (`display.ts`). No row means every default. Server-only.
 */

import { prisma } from "@polaris/db";
import { displayOf, type PolarDisplay, type PolarPreferencesPatch } from "@/lib/polar/display";

export interface PolarPreferences extends PolarDisplay {
    memory: boolean;
}

const SELECTED = {
    memory: true,
    showTokens: true,
    showCost: true,
    showContextBar: true,
    autoCompact: true
} as const;

export async function polarPreferences(userId: string): Promise<PolarPreferences> {
    const row = await prisma.polarPreference.findUnique({ where: { userId }, select: SELECTED });
    return { memory: row?.memory ?? true, ...displayOf(row) };
}

/** Applies a change, owner-scoped by the key, and answers the whole result. */
export async function setPolarPreferences(
    userId: string,
    patch: PolarPreferencesPatch
): Promise<PolarPreferences> {
    const data = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => typeof value === "boolean")
    ) as PolarPreferencesPatch;
    const row = await prisma.polarPreference.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
        select: SELECTED
    });
    return { memory: row.memory, ...displayOf(row) };
}
