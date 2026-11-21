/**
 * An uploaded pack or world, put on a server that already exists.
 *
 * A pack changes what the server runs and keeps its world, the way choosing a
 * Modrinth modpack does: the loader and release the pack names, the pack itself
 * for the image to unpack on the next boot, and the mods somebody chose for the
 * previous software taken off the list. The image keeps a record of what a pack
 * put on the disk and takes it away again when a different one replaces it.
 *
 * A world is the New world button with the level fetched instead of generated:
 * the old one stays on the disk under its own name and can be switched back to.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { newWorld } from "../world-service";
import { loaderSpecOf } from "../loader-pin";
import { formatMemory } from "../blueprints";
import { mapAddresses } from "../world-address";
import { gameMessage } from "../../game-message";
import { parseMemoryMb } from "../../games-service";
import { PROJECTS_KEY, SOFTWARE_KEY } from "../join-guard";
import { archiveUrl, readArchive, type ArchiveInfo } from "./store";
import { GENERIC_PACK_KEY, packHeapMb, WORLD_KEY } from "../../games-create";

const { listEnvVars, setEnvVars } = host.envVarService;
const { deployApplication } = host.deployService;

async function javaServer(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true }
    });
    if (!install?.applicationId) throw new Error(gameMessage("games", "lib.notDeployed"));
    if (install.catalogId.includes("bedrock"))
        throw new Error(gameMessage("games", "lib.archiveJavaOnly"));
    return install.applicationId;
}

async function archiveOf(id: string, kind: "pack" | "world"): Promise<ArchiveInfo> {
    const archive = await readArchive(id);
    if (!archive || archive.kind !== kind)
        throw new Error(gameMessage("games", kind === "pack" ? "lib.packGone" : "lib.worldGone"));
    return archive;
}

/**
 * The variables a pack puts on a server. `software` is what to run when the
 * pack does not say - the screen asks for it then - and is ignored when it does.
 */
export function packVars(
    pack: ArchiveInfo,
    url: string,
    current: ReadonlyMap<string, string>,
    software?: string
): Record<string, string> {
    const type = pack.loader?.type ?? software ?? "";
    const spec = loaderSpecOf(type);
    if (!spec) throw new Error(gameMessage("games", "lib.packNeedsLoader"));
    const vars: Record<string, string> = {
        [SOFTWARE_KEY]: spec.type,
        [GENERIC_PACK_KEY]: url,
        // The other ways a server is handed a set of mods, which would install
        // over the top of this one.
        MODRINTH_MODPACK: "",
        CUSTOM_SERVER: "",
        // Chosen for a different server: the pack brings its own.
        [PROJECTS_KEY]: "",
        [spec.key]: pack.loader?.version ?? ""
    };
    for (const key of spec.legacyKeys) vars[key] = "";
    if (pack.loader?.minecraft) vars.VERSION = pack.loader.minecraft;
    const heap = parseMemoryMb(current.get("MEMORY") ?? "");
    const wanted = packHeapMb(heap, pack);
    if (wanted > heap) vars.MEMORY = formatMemory(wanted);
    return vars;
}

/** Puts an uploaded server pack on a server and restarts it onto it. */
export async function applyServerPack(
    ownerId: string,
    installedAppId: string,
    actorId: string,
    input: { archiveId: string; software?: string }
): Promise<ArchiveInfo> {
    const applicationId = await javaServer(ownerId, installedAppId);
    const pack = await archiveOf(input.archiveId, "pack");
    const vars = await listEnvVars("application", applicationId, ownerId);
    const current = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const url = archiveUrl(await mapAddresses(), "pack", pack.id);
    const next = packVars(pack, url, current, input.software);
    const changed = Object.entries(next).filter(([key, value]) => current.get(key) !== value);
    if (changed.length > 0)
        await setEnvVars(
            "application",
            applicationId,
            ownerId,
            changed.map(([key, value]) => ({ key, value, isSecret: false }))
        );
    await deployApplication(applicationId, ownerId, actorId);
    return pack;
}

/** Plays an uploaded world on a server, keeping the one it had. */
export async function importWorld(
    ownerId: string,
    installedAppId: string,
    actorId: string,
    archiveId: string
): Promise<{ level: string }> {
    const applicationId = await javaServer(ownerId, installedAppId);
    const world = await archiveOf(archiveId, "world");
    const url = archiveUrl(await mapAddresses(), "world", world.id);
    // Before the new level is named: naming it deploys, and the image fetches
    // the world only for a level folder that does not exist yet.
    await setEnvVars("application", applicationId, ownerId, [
        { key: WORLD_KEY, value: url, isSecret: false }
    ]);
    const created = await newWorld(
        ownerId,
        installedAppId,
        { keepPlayers: false, fromMap: true },
        actorId
    );
    return { level: created.level };
}
