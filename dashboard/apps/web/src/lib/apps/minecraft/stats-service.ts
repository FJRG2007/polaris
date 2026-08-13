/**
 * The game's own figures for a player, out of the world folder.
 *
 * Minecraft has been keeping these since long before anybody was watching: a file
 * per player beside the world, holding playtime, deaths and kills counted by the
 * server itself. It is worth more than anything Polaris can total up from the
 * outside, because it covers every session the world has ever had - including the
 * ones from before the sweep existed, and the ones on somebody else's panel.
 *
 * Two files and no plugin. `usercache.json` turns a name into the uuid the game
 * files itself under, and `<level>/stats/<uuid>.json` is the figures. Read on
 * demand for one player rather than swept, because there is one of these per player
 * who has ever joined and nobody is looking at most of them.
 */

import * as world from "./world";
import { withServerContainer } from "./service";
import { listEnvVars } from "@/lib/env-var-service";
import { readPlayerStats, type PlayerStats } from "@/lib/apps/games-activity";

/** The map from a name to the uuid the world files it under. Written by the server
 *  whenever somebody joins, so it holds everyone who ever has. */
interface CacheEntry {
    readonly name?: unknown;
    readonly uuid?: unknown;
}

/** The uuid this name is filed under, if the server has ever seen it. */
export function uuidFor(usercache: string, name: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(usercache);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const wanted = name.trim().toLowerCase();
    for (const entry of parsed as CacheEntry[]) {
        if (typeof entry?.name !== "string" || typeof entry?.uuid !== "string") continue;
        // Newest last in the file, so the last match wins: a name that changed
        // hands is filed under whoever holds it now.
        if (entry.name.trim().toLowerCase() === wanted) return entry.uuid;
    }
    return null;
}

/**
 * What the server has counted for this player, or null.
 *
 * Null covers every ordinary way this comes to nothing - a Bedrock server, which
 * files none of it; somebody who has never joined; a world too young to have
 * written the file - and none of them are worth an error on a dialog that has
 * plenty else to show.
 */
export async function readMinecraftStats(
    ownerId: string,
    installedAppId: string,
    name: string
): Promise<PlayerStats | null> {
    try {
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            if (server.edition === "bedrock") return null;

            const vars = await listEnvVars("application", server.applicationId, ownerId).catch(() => []);
            const level = vars.find((entry) => entry.key === world.levelEnvKey("java"))?.value?.trim();
            if (!level) return null;

            const cache = await server.run(["cat", "--", `${world.DATA_DIR}/usercache.json`]);
            if (cache.code !== 0) return null;
            const uuid = uuidFor(cache.output, name);
            if (uuid === null || !/^[0-9a-fA-F-]{32,36}$/.test(uuid)) return null;

            const stats = await server.run(["cat", "--", `${world.DATA_DIR}/${level}/stats/${uuid}.json`]);
            return stats.code === 0 ? readPlayerStats(stats.output) : null;
        });
    } catch {
        return null;
    }
}
