/**
 * The mods one ARK server runs.
 *
 * The list is an environment variable the image hands to arkmanager, which
 * downloads each id from the Workshop when the server starts. So changing it is
 * changing what the next start installs - nothing here reaches a running world,
 * and the screen says so rather than pretending a mod appeared.
 *
 * Two lists, not one. The ordinary mods load in order and later ones win; the map
 * mod is separate because it is not a mod the server loads on top of a map, it is
 * the map, and giving it its own field is what stops somebody pasting a map id
 * into the mod list and getting a server that starts on The Island with a mod
 * installed and unused.
 *
 * What is on disk is read separately from what is configured, because the two
 * differ for a whole start: a mod added a minute ago is on the list and not yet
 * downloaded, and an operator watching a 3 GB mod install needs to see which of
 * the two states each row is in.
 */

import { prisma } from "@polaris/db";
import { setEnvVars } from "@/lib/env-var-service";
import { ARK_ROOT } from "@/lib/apps/ark/files";
import { withServerContainer } from "@/lib/apps/minecraft/service";
import { formatModIds, isModId, parseModIds } from "@/lib/apps/ark/mods";
import type { WorkshopItem } from "@/lib/apps/ark/workshop";
import { readWorkshopItems } from "@/lib/apps/ark/workshop-service";

/** Where arkmanager puts a mod it has downloaded. One folder per Workshop id. */
const MODS_DIR = `${ARK_ROOT}/ShooterGame/Content/Mods`;

/** The two variables the image reads a mod list out of. */
const MOD_LIST = "GAME_MOD_IDS";
const MAP_MOD = "SERVER_MAP_MOD_ID";

export interface ArkModsView {
    /** The mods the server is configured to run, in load order. */
    readonly ids: readonly string[];
    /** The Workshop id of a custom map, when the server runs one. */
    readonly mapModId: string | null;
    /** The ids that are actually downloaded onto the server, which is not the same
     *  question. Empty when the server is not up to be asked. */
    readonly installed: readonly string[];
    /** What Steam says about each of them. Empty for an instance that cannot reach
     *  Steam - the ids are still shown, since they are what the server runs. */
    readonly items: readonly WorkshopItem[];
}

/** The application behind an install, and the ARK-only check with it. */
async function requireArkApplication(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    if (!install?.applicationId) throw new Error("This server has not been deployed yet");
    return install.applicationId;
}

async function readModVars(applicationId: string): Promise<{ ids: string[]; mapModId: string | null }> {
    const vars = await prisma.envVar.findMany({
        where: { scopeType: "application", scopeId: applicationId, key: { in: [MOD_LIST, MAP_MOD] } },
        select: { key: true, value: true }
    });
    const mapMod = (vars.find((row) => row.key === MAP_MOD)?.value ?? "").trim();
    return {
        ids: parseModIds(vars.find((row) => row.key === MOD_LIST)?.value ?? ""),
        mapModId: isModId(mapMod) ? mapMod : null
    };
}

/** Which of them are downloaded. Empty for a server that is not up: that is not
 *  the same as "none installed", and the screen draws the difference. */
async function readInstalledMods(ownerId: string, installedAppId: string): Promise<string[]> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const listing = await server.run(["sh", "-c", `ls -1 ${MODS_DIR} 2>/dev/null || true`]);
        return listing.output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => isModId(line));
    }).catch(() => []);
}

/** What this server runs, what it has downloaded, and what Steam says about it. */
export async function readArkMods(ownerId: string, installedAppId: string): Promise<ArkModsView> {
    const applicationId = await requireArkApplication(ownerId, installedAppId);
    const { ids, mapModId } = await readModVars(applicationId);
    const [installed, items] = await Promise.all([
        readInstalledMods(ownerId, installedAppId),
        readWorkshopItems([...ids, ...(mapModId ? [mapModId] : [])]).catch(() => [])
    ]);
    return { ids, mapModId, installed, items };
}

/**
 * Replace the mod list, in the order given.
 *
 * The whole list rather than one id at a time, because the order is part of it:
 * adding, removing and moving are all the same write, and a per-id call would
 * make reordering three of them with a window in between where the server would
 * have started on something nobody chose.
 */
export async function setArkMods(
    ownerId: string,
    installedAppId: string,
    ids: readonly string[]
): Promise<void> {
    const applicationId = await requireArkApplication(ownerId, installedAppId);
    for (const id of ids) if (!isModId(id)) throw new Error("That is not a Steam Workshop id");
    await setEnvVars("application", applicationId, ownerId, [
        { key: MOD_LIST, value: formatModIds([...ids]), isSecret: false }
    ]);
}

/** Set or clear the custom map the server runs. Null puts it back on the map its
 *  own settings name. */
export async function setArkMapMod(
    ownerId: string,
    installedAppId: string,
    id: string | null
): Promise<void> {
    const applicationId = await requireArkApplication(ownerId, installedAppId);
    if (id !== null && !isModId(id)) throw new Error("That is not a Steam Workshop id");
    await setEnvVars("application", applicationId, ownerId, [
        { key: MAP_MOD, value: id ?? "", isSecret: false }
    ]);
}

/**
 * Whether the running server has been told about a mod list that no longer
 * matches the one Polaris holds.
 *
 * The image reads both variables when the container starts, so a change is only
 * in force after a restart - and the screen has to be able to say which of its
 * rows are already running and which are waiting for one.
 */
export function modsPending(view: ArkModsView): string[] {
    const wanted = [...view.ids, ...(view.mapModId ? [view.mapModId] : [])];
    return wanted.filter((id) => !view.installed.includes(id));
}

