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
import * as phases from "./oneblock-phases";
import { serverVersion } from "./server-version";
import { host } from "@polaris/app-host";
import { BLUEPRINT_KEY } from "../games-create";
import { withServerContainer } from "./service";
import { levelOf } from "./mod-announcements-service";
import { readContainerFile, writeContainerFile } from "../container-files";
import type { FileReader } from "../container-files";

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
    const blueprintId = stored[BLUEPRINT_KEY];
    if (typeof blueprintId !== "string" || !oneblock.ONEBLOCK_BLUEPRINT_IDS.includes(blueprintId))
        return;
    // Isolated: a phases write that fails must not keep the first block from
    // being placed, and is tried again on the next pass.
    if (
        blueprintId === oneblock.ONEBLOCK_CLASSIC_BLUEPRINT_ID &&
        stored[phases.ONEBLOCK_PHASES_KEY] !== phases.CLASSIC_PHASES
    )
        await applyClassicPhases(ownerId, installedAppId).catch((error) =>
            console.warn("polaris: OneBlock classic phases failed", installedAppId, String(error))
        );
    if (stored[oneblock.ONEBLOCK_READY_KEY] === true) return;
    const previous = stored[oneblock.ONEBLOCK_WORLD_KEY];
    const outcome = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return null;
        const plugin = await readPluginConfig(server);
        // Not there yet: the plugin writes it the first time it loads.
        if (plugin === null) return null;
        const file = plugin.config;
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

/**
 * Put the classic phases in place of the plugin's own levels, once.
 *
 * Waits for the plugin's settings file, the sign that it has loaded and written
 * its bundled levels, so this one replaces them rather than being replaced. Then
 * the plugin is told to read its files again. Recorded the moment the file is
 * written: from then on the levels are the operator's to change, and a server
 * whose console missed the reload picks them up on its next start anyway.
 */
async function applyClassicPhases(ownerId: string, installedAppId: string): Promise<void> {
    const written = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return false;
        const plugin = await readPluginConfig(server);
        if (plugin === null) return false;
        // The release it started as, so the ladder holds only what it has; a log
        // that does not say yet is read again on the next pass.
        const version = await serverVersion(server);
        if (!version) return false;
        await writeContainerFile(
            server,
            `${plugin.dir}/${phases.ONEBLOCK_BLOCKS_FILE}`,
            phases.phasesFile(phases.phasesFor(version))
        );
        await server.sayAll(["ob reload"]);
        return true;
    });
    if (written)
        await patchInstallConfig(installedAppId, {
            [phases.ONEBLOCK_PHASES_KEY]: phases.CLASSIC_PHASES
        });
}

/** The plugin's folder and its settings file, or null before it has written one. */
async function readPluginConfig(server: FileReader): Promise<{ dir: string; config: string } | null> {
    for (const dir of oneblock.ONEBLOCK_DIRS) {
        const config = await readContainerFile(server, `${dir}/${oneblock.ONEBLOCK_CONFIG_FILE}`);
        if (config !== null) return { dir, config };
    }
    return null;
}
