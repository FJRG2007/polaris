/**
 * Where an account's sound volume is stored. One nullable column: null means the
 * account never chose, and follows the default in code.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import { asSoundVolume } from "./sound-volume";

/** The volume in force for an account, memoized per request. */
export const getSoundVolume = cache(async (userId: string): Promise<number> => {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { soundVolume: true }
    });
    return asSoundVolume(row?.soundVolume ?? undefined);
});

/** Store a volume the caller has already validated. */
export async function saveSoundVolume(userId: string, volume: number): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { soundVolume: volume } });
}
