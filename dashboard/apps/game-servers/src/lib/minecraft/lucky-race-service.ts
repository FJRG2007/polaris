/**
 * Setting a Lucky Block Race server up (`lucky-race.ts`), from the walk every
 * running server already gets.
 *
 * Waits for the Lucky Blocks pack the image downloads at boot - the course is
 * built out of its blocks, so a course built before it is there is a course of
 * hay bales - then writes the race pack, switches it on, sets the world rules
 * and builds the course. Recorded only once the game has said the pack is on;
 * a server still starting, or a console that did not answer, is tried again on
 * the next pass, and one that never takes it is given up on.
 */

import { DATA_DIR } from "./world";
import * as race from "./lucky-race";
import { host } from "@polaris/app-host";
import { BLUEPRINT_KEY } from "../games-create";
import { withServerContainer } from "./service";
import { homeLanguage } from "./speech-service";
import { chosenLanguage } from "./events/catalog";
import { ensureDatapack } from "./datapack-install";
import { levelOf } from "./mod-announcements-service";
import { listContainerDir } from "../container-files";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

export async function applyLuckyRaceSetup(
    ownerId: string,
    installedAppId: string,
    config: string | null
): Promise<void> {
    const stored = readInstallConfig(config);
    if (!race.wantsRace(stored[BLUEPRINT_KEY])) return;
    if (stored[race.RACE_SETUP_KEY] === race.RACE_VERSION) return;
    const tries = Number(stored[race.RACE_TRIES_KEY] ?? 0);
    if (tries >= race.MAX_TRIES) return;
    const language = await homeLanguage(ownerId, chosenLanguage(stored));
    const done = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return null;
        const level = await levelOf(server);
        if (!level) return null;
        const packs = await listContainerDir(server, `${DATA_DIR}/${level}/datapacks`);
        if (!race.hasLuckyPack(packs)) return null;
        const on = await ensureDatapack(server, {
            dir: race.RACE_PACK_DIR,
            files: race.racePackFiles(language),
            label: "Lucky Block Race"
        });
        if (!on) return false;
        await server.sayAll(race.consoleLines());
        return true;
    });
    // Not up yet, or no Lucky Blocks pack yet: not a try.
    if (done === null) return;
    await patchInstallConfig(
        installedAppId,
        done
            ? { [race.RACE_SETUP_KEY]: race.RACE_VERSION, [race.RACE_TRIES_KEY]: 0 }
            : { [race.RACE_TRIES_KEY]: tries + 1 }
    );
}
