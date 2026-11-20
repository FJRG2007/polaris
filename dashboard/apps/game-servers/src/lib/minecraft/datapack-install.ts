/**
 * Putting a data pack Polaris generates onto a server and switching it on.
 *
 * Written only where a file differs from what Polaris ships, so a second visit
 * reads the files and changes nothing. Taken in with `/datapack`, never
 * `/reload`: on Paper and Spigot the bare `reload` is Bukkit's, which reloads
 * every plugin. `datapack list available` is what makes the game look in the
 * folder again, so a pack written since the server started is found. Switching
 * a pack on reloads the game's data, a short pause.
 */

import { DATA_DIR } from "./world";
import type { ServerContainer } from "./service";
import { levelOf } from "./mod-announcements-service";
import { readContainerFiles, writeContainerFile } from "../container-files";

export interface GeneratedPack {
    /** The pack's folder inside the level's `datapacks`. */
    readonly dir: string;
    /** Its files, by their path inside that folder. */
    readonly files: ReadonlyMap<string, string>;
    /** Files an older Polaris wrote and this one does not. */
    readonly retired?: readonly string[];
    /** A name for the log line. */
    readonly label: string;
}

/** The id `/datapack` knows a pack in a level's folder by. */
export function packId(dir: string): string {
    return `file/${dir}`;
}

/** Whether `datapack list enabled` names the pack. */
export function packEnabled(said: string, dir: string): boolean {
    const id = packId(dir);
    return said.includes(`[${id}`) || said.includes(`${id} (`);
}

/** Whether the pack is on the server and switched on - the files written where
 *  they were missing or older, and the pack taken in again when they were. */
export async function ensureDatapack(server: ServerContainer, pack: GeneratedPack): Promise<boolean> {
    const level = await levelOf(server);
    if (!level) return false;
    const root = `${DATA_DIR}/${level}/datapacks/${pack.dir}`;
    const retired = (pack.retired ?? []).map((path) => `${root}/${path}`);
    const paths = [...pack.files.keys()].map((path) => `${root}/${path}`);
    const there = await readContainerFiles(server, [...paths, ...retired]);
    let changed = false;
    for (const [path, content] of pack.files) {
        if (there.get(`${root}/${path}`) === content) continue;
        await writeContainerFile(server, `${root}/${path}`, content);
        changed = true;
    }
    // What an older Polaris wrote and this one does not: the game would go on
    // loading it, and logging it as broken at every start.
    const stale = retired.filter((path) => there.has(path));
    if (stale.length > 0) {
        await server.run(["rm", "-f", "--", ...stale]);
        changed = true;
    }
    const id = packId(pack.dir);
    const enabled = async () => packEnabled(await server.say(["datapack list enabled"]), pack.dir);
    if (await enabled()) {
        if (!changed) return true;
        // Already on, with older functions: off and on again is what reads them.
        await server.say([`datapack disable "${id}"`]);
    }
    const reloading = Date.now();
    await server.say(["datapack list available"]);
    await server.say([`datapack enable "${id}"`]);
    // Switching it on reloads the game's data; on a server with many mods that
    // is the pause somebody notices, so it is measured.
    console.info(
        `[minecraft] ${pack.label} pack switched on in ${Math.round((Date.now() - reloading) / 1000)}s`
    );
    return enabled();
}
