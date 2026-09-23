"use server";

/**
 * What the Hytale screen may ask the server about.
 *
 * One question, and it is the whole of what this game needs before it runs: are
 * its files there. Everything else a Hytale server does - starting, stopping, its
 * log, its address, its files - is what every game server here already has.
 *
 * A read, so it is gated on being allowed to see the server rather than on being
 * allowed to change it, and nothing is recorded: looking at whether a file exists
 * is not an administrative act.
 */

import { host } from "@polaris/app-host";
import { readHytaleFiles } from "../../lib/hytale/service";
import type { HytaleFiles } from "../../lib/hytale/paths";

const { requireGameServer } = host.appsInstallAccess;

export async function hytaleFilesAction(
    installedAppId: string
): Promise<{ files?: HytaleFiles; error?: string }> {
    try {
        const { access } = await requireGameServer("games.read", installedAppId);
        return { files: await readHytaleFiles(access.ownerId, installedAppId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That server did not answer." };
    }
}
