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

import { createHash } from "node:crypto";
import * as pack from "./snowball-pack";
import type { ServerContainer } from "../../service";
import { ensureDatapack } from "../../datapack-install";

/** Whether the pack is on the server and switched on - the files written where
 *  they were missing or older, and the pack taken in again when they were. */
/** The pack's files as this Polaris writes them, in short: what the minute
 *  sweep compares to know a server already has them. */
export function packVersion(): string {
    const hash = createHash("sha256");
    for (const [path, content] of pack.packFiles()) hash.update(path).update("\0").update(content);
    return hash.digest("hex");
}

export async function ensurePack(server: ServerContainer): Promise<boolean> {
    return ensureDatapack(server, {
        dir: pack.PACK_DIR,
        files: pack.packFiles(),
        retired: pack.RETIRED_FILES,
        label: "event"
    });
}
