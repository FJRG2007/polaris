/**
 * Setting OneBlock up on a server that has just come up with it, from the walk
 * every running server already gets (see `oneblock.ts` for why the plugin's own
 * file decides whether that is needed).
 *
 * Nothing here can fail a walk: a server still starting, a plugin not loaded yet
 * or a console that does not answer all leave it for the next pass, and the file
 * read on that pass is what says whether this one worked.
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
    const ready = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return false;
        const file = await readContainerFile(server, oneblock.ONEBLOCK_CONFIG_PATH);
        // Not there yet: the plugin writes it the first time it loads.
        if (file === null) return false;
        const level = await levelOf(server);
        if (!level) return false;
        if (oneblock.isSetUp(file, level)) return true;
        await server.sayAll(oneblock.setupLines(level));
        // Not marked here: the next pass reads the file the command wrote, which
        // is the only evidence that the plugin took it.
        return false;
    });
    if (ready) await patchInstallConfig(installedAppId, { [oneblock.ONEBLOCK_READY_KEY]: true });
}
