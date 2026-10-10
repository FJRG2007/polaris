/**
 * Which event moments a server has its own sound on, as the line sender asks.
 *
 * Asked on every command that leaves for a Java server, so it is answered from
 * memory: one read per server per half minute, and at once again after the
 * Sounds tab changed something (`forgetMomentOverrides`). A server with no
 * sounds costs one small read per half minute and changes nothing it is sent.
 */

import { prisma } from "@polaris/db";
import { readSoundSettings } from "./sounds";
import { momentOverrides, type MomentOverrides } from "./sound-moments";

const TTL_MS = 30_000;
const NONE: MomentOverrides = new Map();

const known = new Map<
    string,
    { readonly at: number; readonly overrides: Promise<MomentOverrides> }
>();

async function read(installedAppId: string): Promise<MomentOverrides> {
    const pack = await prisma.minecraftSoundPack.findUnique({
        where: { installedAppId },
        select: { settings: true }
    });
    if (!pack) return NONE;
    const settings = readSoundSettings(pack.settings);
    const used = new Set(Object.values(settings.moments).map((use) => use.sound));
    if (used.size === 0) return NONE;
    const present = await prisma.minecraftSound.findMany({
        where: { installedAppId, key: { in: [...used] } },
        select: { key: true }
    });
    return momentOverrides(settings.moments, new Set(present.map((one) => one.key)));
}

/** The server's own sounds on event moments; none when it has none or they
 *  could not be read (an event then sounds as it always did). */
export function soundMomentOverrides(
    installedAppId: string,
    now: number = Date.now()
): Promise<MomentOverrides> {
    const cached = known.get(installedAppId);
    if (cached && now - cached.at < TTL_MS) return cached.overrides;
    const overrides = read(installedAppId).catch(() => NONE);
    known.set(installedAppId, { at: now, overrides });
    return overrides;
}

export function forgetMomentOverrides(installedAppId: string): void {
    known.delete(installedAppId);
}
