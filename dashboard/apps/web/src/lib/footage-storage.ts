/**
 * Where camera footage is written.
 *
 * A storage setting like the other kinds under Admin > Uploads, so it is core:
 * the Uploads screen shows and changes it, and Places reads it when it writes.
 *
 * Server-only.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import {
    resolveTargetChoice,
    storageTargetOptions,
    AUTOMATIC_TARGET,
    type UploadTarget
} from "@/lib/storage-target";

/** The setting an administrator points the house's footage at, under Uploads
 *  beside the other kinds. Its own key rather than sharing the attachments one:
 *  footage is the biggest thing Polaris writes and the most likely to want a
 *  disk of its own. */
export const HOME_TARGET_KEY = "home.storage.target";

/** What the Uploads screen shows and changes for camera footage: the choice, and
 *  where it currently resolves to. */
export interface FootageSettings {
    readonly choice: string;
    readonly resolved: UploadTarget;
    readonly options: Awaited<ReturnType<typeof storageTargetOptions>>;
}

export async function footageSettings(): Promise<FootageSettings> {
    const [choice, resolved, options] = await Promise.all([
        getSetting(HOME_TARGET_KEY),
        footageTarget(null),
        storageTargetOptions()
    ]);
    return { choice: choice || AUTOMATIC_TARGET, resolved, options };
}

export async function setFootageTarget(target: string): Promise<void> {
    await setSetting(HOME_TARGET_KEY, target);
}

/**
 * Where one camera's footage goes.
 *
 * The camera's own choice, and the instance's when it has none - which is what
 * nearly every camera keeps. Both go through the same resolver, so a connection
 * somebody deleted falls through to the automatic rule instead of failing every
 * write from then on.
 */
export async function footageTarget(cameraChoice: string | null): Promise<UploadTarget> {
    return resolveTargetChoice(cameraChoice || (await getSetting(HOME_TARGET_KEY)));
}
