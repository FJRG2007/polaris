/**
 * Putting the snowball pack (`snowball-pack.ts`) on a server and switching it on.
 *
 * Written only where a file differs from what Polaris ships, so the second game
 * on a server reads the files and changes nothing. Taken in with `/datapack`,
 * never `/reload`: on Paper and Spigot the bare `reload` is Bukkit's, which
 * reloads every plugin. `datapack list available` is what makes the game look
 * in the folder again, so a pack written since the server started is found.
 * Switching a pack on reloads the game's data, a short pause - which is why this
 * runs while the players are still being told to get ready, not when they throw.
 */

import { DATA_DIR } from "../../world";
import * as pack from "./snowball-pack";
import type { ServerContainer } from "../../service";
import { levelOf } from "../../mod-announcements-service";
import { readContainerFiles, writeContainerFile } from "../../../container-files";

/** Whether the pack is on the server and switched on - the files written where
 *  they were missing or older, and the pack taken in again when they were. */
export async function ensurePack(server: ServerContainer): Promise<boolean> {
    const level = await levelOf(server);
    if (!level) return false;
    const root = `${DATA_DIR}/${level}/datapacks/${pack.PACK_DIR}`;
    const files = pack.packFiles();
    const paths = [...files.keys()].map((path) => `${root}/${path}`);
    const there = await readContainerFiles(server, paths);
    let changed = false;
    for (const [path, content] of files) {
        if (there.get(`${root}/${path}`) === content) continue;
        await writeContainerFile(server, `${root}/${path}`, content);
        changed = true;
    }
    const enabled = async () => pack.packEnabled(await server.say(["datapack list enabled"]));
    if (await enabled()) {
        if (!changed) return true;
        // Already on, with older functions: off and on again is what reads them.
        await server.say([`datapack disable "${pack.PACK_ID}"`]);
    }
    await server.say(["datapack list available"]);
    await server.say([`datapack enable "${pack.PACK_ID}"`]);
    return enabled();
}
