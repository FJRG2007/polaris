/**
 * The Skyblock 2.1 map's extra islands, put up from the walk every running
 * server already gets (see `skyblock-islands.ts` for what they are and why every
 * line only ever fills air).
 *
 * On a live server, with nobody stopping it: the islands' chunks are held loaded
 * while they go up, each island is then asked whether it is standing, and the
 * pass that first sees one standing is the one that fills its chests and lets
 * its bees out. Only once every island answers is the server marked done and
 * the chunks let go; a pass that did not finish leaves the rest to the next one,
 * and a world that never takes them stops being visited after a few.
 *
 * Nothing here can fail a walk.
 */

import { host } from "@polaris/app-host";
import { MAP_KEY } from "../games-create";
import { readTest } from "./events/commands";
import * as islands from "./skyblock-islands";
import { answersOf } from "./events/commands";
import { withServerContainer, type ServerContainer } from "./service";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** What a pass ended in: done, or worth another pass. */
type Outcome = "done" | "again";

/**
 * Put the islands up on this server when it plays the Skyblock 2.1 map and they
 * are not there yet. `config` is the install's stored config, which the caller
 * already read.
 */
export async function applySkyblockIslands(
    ownerId: string,
    installedAppId: string,
    config: string | null
): Promise<void> {
    const stored = readInstallConfig(config);
    if (stored[MAP_KEY] !== islands.SKYBLOCK_MAP_ID) return;
    if (stored[islands.SKYBLOCK_ISLANDS_KEY] === true) return;
    const outcome = await withServerContainer(ownerId, installedAppId, async (server) =>
        server.running && server.edition === "java" ? putUp(server) : null
    );
    if (outcome === null) return;
    const tries = Number(stored[islands.SKYBLOCK_ISLANDS_TRIES_KEY] ?? 0) + 1;
    if (outcome === "done") {
        await patchInstallConfig(installedAppId, { [islands.SKYBLOCK_ISLANDS_KEY]: true });
        return;
    }
    if (tries >= islands.MAX_TRIES) {
        // Given up on: the chunks this held are let go, and the server is left
        // with whatever islands did go up.
        await withServerContainer(ownerId, installedAppId, (server) =>
            server.sayAll(islands.ISLANDS.map((island) => islands.forceloadLine(island, false)))
        ).catch(() => undefined);
        await patchInstallConfig(installedAppId, { [islands.SKYBLOCK_ISLANDS_KEY]: true });
        return;
    }
    await patchInstallConfig(installedAppId, { [islands.SKYBLOCK_ISLANDS_TRIES_KEY]: tries });
}

/** Which islands answer that they are standing; null for one that could not say. */
async function standing(
    server: ServerContainer,
    wanted: readonly islands.Island[]
): Promise<(boolean | null)[]> {
    const answers = await answersOf(
        server,
        wanted.map((island) => islands.presentLine(island)),
        (line) => server.say([line]).catch(() => "")
    );
    return answers.map((answer) => {
        const test = readTest(answer);
        return test === "passed" ? true : test === "failed" ? false : null;
    });
}

/** One pass: look, put up what is missing, look again. */
async function putUp(server: ServerContainer): Promise<Outcome | null> {
    // Not this map's world - another level, or the start island gone - and so
    // nowhere these belong. A server that cannot answer yet is asked next pass.
    const start = readTest(await server.say([islands.START_PRESENT]).catch(() => ""));
    if (start === "failed") return "done";
    if (start !== "passed") return null;
    const before = await standing(server, islands.ISLANDS);
    const missing = islands.ISLANDS.filter((_, at) => before[at] !== true);
    if (missing.length > 0) {
        await server.sayAll(missing.map((island) => islands.forceloadLine(island, true)));
        await server.sayAll(missing.flatMap((island) => islands.placeLines(island)));
        const after = await standing(server, missing);
        const risen = missing.filter((_, at) => after[at] === true);
        // Only the pass that saw them go up fills the chests and lets the bees
        // out, so a second look never doubles either.
        const extras = risen.flatMap((island) => island.extras);
        if (extras.length > 0) await server.sayAll(extras);
        if (risen.length < missing.length) return "again";
    }
    await server.sayAll(islands.ISLANDS.map((island) => islands.forceloadLine(island, false)));
    return "done";
}
