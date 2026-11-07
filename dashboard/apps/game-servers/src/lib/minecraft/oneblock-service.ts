/**
 * Setting OneBlock up on a server that has just come up with it, from the walk
 * every running server already gets (see `oneblock.ts` for why the plugin's own
 * file decides whether that is needed).
 *
 * Nothing here can fail a walk: a server still starting, a plugin not loaded yet
 * or a console that does not answer all leave it for the next pass, and the file
 * read on that pass is what says whether this one worked. A plugin that is told
 * a few times and never takes it is given up on.
 */

import * as oneblock from "./oneblock";
import { host } from "@polaris/app-host";
import { BLUEPRINT_KEY } from "../games-create";
import { withServerContainer } from "./service";
import { levelOf } from "./mod-announcements-service";
import { readContainerFile } from "../container-files";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/**
 * Set the plugin up on this server when it is a OneBlock server that has not been
 * yet. `config` is the install's stored config, which the caller already read.
 */
export async function applyOneBlockSetup(
    ownerId: string,
    installedAppId: string,
    config: string | null
): Promise<void> {
    const stored = readInstallConfig(config);
    if (stored[BLUEPRINT_KEY] !== oneblock.ONEBLOCK_BLUEPRINT_ID) return;
    if (stored[oneblock.ONEBLOCK_READY_KEY] === true) return;
    const previous = stored[oneblock.ONEBLOCK_WORLD_KEY];
    const outcome = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return null;
        const file = await readContainerFile(server, oneblock.ONEBLOCK_CONFIG_PATH);
        // Not there yet: the plugin writes it the first time it loads.
        if (file === null) return null;
        const level = await levelOf(server);
        if (!level) return null;
        if (oneblock.isSetUp(file, level, typeof previous === "string" ? previous : null))
            return { level };
        await server.sayAll(oneblock.setupLines(level));
        // Not marked here: the next pass reads the file the command wrote, which
        // is the only evidence that the plugin took it.
        return { level: null };
    });
    if (!outcome) return;
    if (outcome.level !== null) {
        await patchInstallConfig(installedAppId, {
            [oneblock.ONEBLOCK_READY_KEY]: true,
            [oneblock.ONEBLOCK_WORLD_KEY]: outcome.level,
            [oneblock.ONEBLOCK_TRIES_KEY]: 0
        });
        return;
    }
    const tries = Number(stored[oneblock.ONEBLOCK_TRIES_KEY] ?? 0) + 1;
    await patchInstallConfig(
        installedAppId,
        tries >= oneblock.MAX_TRIES
            ? { [oneblock.ONEBLOCK_READY_KEY]: true, [oneblock.ONEBLOCK_TRIES_KEY]: 0 }
            : { [oneblock.ONEBLOCK_TRIES_KEY]: tries }
    );
}
