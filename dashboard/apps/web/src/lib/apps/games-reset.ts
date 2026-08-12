/**
 * Resetting a Minecraft server: the same server, built again as something else.
 *
 * The alternative people reach for is deleting the server and creating a new one,
 * and it costs them everything that was not the game. The name on the domain goes
 * and comes back pointing somewhere else, the players have to be added again one
 * at a time, the grants that let somebody else moderate it are gone, the port
 * moves, and anybody who had the address written down has the wrong one. None of
 * that is what "start this server over" means.
 *
 * So a reset changes only the shape - which blueprint, which release, what
 * software, and the map it generates - and deliberately touches nothing else. The
 * address, the player list, the access other people hold on it, the schedule, the
 * name, the icon, the description and the port all stay exactly as they were,
 * because none of them are what the operator is trying to replace.
 *
 * The old map is kept rather than deleted, for the reason every other world
 * operation here keeps it: the server boots into a new level and the previous one
 * is still on disk, so a reset somebody regrets is a switch back under World
 * rather than a restore from a backup they may not have. Deleting it is a
 * separate, deliberate act on that screen.
 */

import { prisma } from "@polaris/db";
import { editionOf } from "@/lib/apps/minecraft/service";
import { readAppRuntimeLog } from "@/lib/deploy-service";
import { hasCrossplay } from "@/lib/apps/minecraft/blueprints";
import { parseServerVersion } from "@/lib/apps/minecraft/parse";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { DEFAULT_LEVEL_TYPE } from "@/lib/apps/minecraft/world";
import { wantsLatest } from "@/lib/apps/minecraft/blueprint-version";
import type { ResetMinecraftServerInput } from "@/lib/apps/games-schema";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { newWorld, setAsideVersionedConfig } from "@/lib/apps/minecraft/world-service";
import {
    BLUEPRINT_KEY,
    blueprintFor,
    MAP_KEY,
    minecraftShapeEnv,
    RELEASE_KEY,
    withoutBlueprintProjects
} from "@/lib/apps/games-create";

/** What the reset dialog asks for, minus which server it is asking about. The
 *  shape of the game and the map it starts on; everything else is left alone. */
export type ResetShape = Omit<ResetMinecraftServerInput, "installedAppId">;

export interface ResetMinecraftServer {
    /** The level it will boot into. */
    readonly level: string;
    /** Whether what players were carrying was copied across. */
    readonly carried: boolean;
    /** The release it was pinned to, which a blueprint may have decided. */
    readonly version: string;
    /** Whether the settings the previous release wrote were set aside, which is
     *  the difference between a server that starts and one that cannot. */
    readonly configReset: boolean;
}

/**
 * Rebuild a server as a blueprint, on a map generated from what was asked for.
 *
 * The environment is worked out by the same function that works it out for a new
 * server, over what this one already holds - so a blueprint means the same thing
 * on a reset as it does on a create. The one part that cannot merge is the plugin
 * list: the previous blueprint's plugin has to come off it, or a server reset
 * from Bed wars to Survival is a survival server still running BedWars1058.
 *
 * Crossplay is read off the container rather than asked for. Bedrock clients join
 * on a second published port, which is decided when the server is deployed - so
 * turning it on is a change to the deployment rather than to the game, and a
 * reset that quietly took the port away would leave a working address answering
 * nothing.
 */
export async function resetMinecraftServer(
    ownerId: string,
    installedAppId: string,
    actorId: string,
    input: ResetShape
): Promise<ResetMinecraftServer> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true, config: true }
    });
    if (!install) throw new Error("Server not found");
    if (!install.applicationId) throw new Error("This server has not been deployed yet");

    const edition = editionOf(install.catalogId);
    const blueprint = blueprintFor(edition, input.blueprintId);

    const vars = await listEnvVars("application", install.applicationId, ownerId);
    const current = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const crossplay = hasCrossplay(current.get("MODRINTH_PROJECTS"));
    // Stripped before the shape is applied, not after: the shape puts the new
    // blueprint's plugins back, and taking them out afterwards would take out the
    // ones it had just added.
    current.set("MODRINTH_PROJECTS", withoutBlueprintProjects(current.get("MODRINTH_PROJECTS")));

    const levelType = input.levelType ?? blueprint.levelType ?? DEFAULT_LEVEL_TYPE;
    const env = await minecraftShapeEnv(
        edition,
        blueprint,
        {
            blueprintId: blueprint.id,
            ...(input.mapId ? { mapId: input.mapId } : {}),
            ...(input.software ? { software: input.software } : {}),
            version: input.version,
            ...(input.seed ? { seed: input.seed } : {}),
            levelType,
            ...(input.biome ? { biome: input.biome } : {}),
            concurrentPlayers: input.concurrentPlayers,
            crossplay
        },
        current
    );

    // Before anything is written, because starting the server is what applies the
    // environment: a set-aside that ran after this would boot the new release
    // against the old release's config, which is the crash it exists to prevent.
    const aside = await setAsideVersionedConfig(ownerId, installedAppId, {
        from: await currentRelease(ownerId, install.applicationId, install.config, current),
        to: resolvedRelease(env.get("VERSION"))
    });

    // Only what actually moved. Writing the whole environment back would rewrite
    // every value this server holds on every reset, which is how a variable
    // somebody set by hand gets quietly restored to what it was.
    const changed = [...env.entries()].filter(([key, value]) => current.get(key) !== value);
    if (changed.length > 0) {
        await setEnvVars(
            "application",
            install.applicationId,
            ownerId,
            changed.map(([key, value]) => ({ key, value, isSecret: false }))
        );
    }
    await patchInstallConfig(installedAppId, {
        [BLUEPRINT_KEY]: blueprint.id,
        [MAP_KEY]: input.mapId ?? "",
        [RELEASE_KEY]: env.get("VERSION") ?? ""
    });

    // The map, and the restart that puts all of this on the server. Generating a
    // new level is the same act as the New world button and it is the same code:
    // it points LEVEL at a folder that does not exist yet, leaves the old one on
    // disk, and deploys.
    //
    // A map lands in a stamped folder rather than under its own name, unlike a
    // server created on one. That is deliberate: a folder that does not exist yet
    // is what makes the image fetch the map again, where reusing the map's name
    // would find the copy that has been played on and boot straight back into it.
    const created = await newWorld(
        ownerId,
        installedAppId,
        {
            ...(input.seed ? { seed: input.seed } : {}),
            levelType,
            ...(input.biome ? { biome: input.biome } : {}),
            keepPlayers: input.keepPlayers,
            fromMap: Boolean(input.mapId)
        },
        actorId
    );
    return {
        level: created.level,
        carried: created.carried,
        version: env.get("VERSION") ?? input.version,
        configReset: aside !== null
    };
}

/**
 * The release this server is running now, as well as it can be known.
 *
 * Three sources, weakest last. What Polaris wrote down when it built the server is
 * exact when it is there at all; what the server announced in its own log is the
 * only answer for one built on `LATEST`, and it is ground truth until the log
 * scrolls past the banner; the variable itself counts only when somebody pinned a
 * release into it. Null means nobody knows - which the caller reads as "assume it
 * changed", because that is the mistake that is cheap to make.
 */
async function currentRelease(
    ownerId: string,
    applicationId: string,
    config: string | null,
    env: ReadonlyMap<string, string>
): Promise<string | null> {
    const recorded = readInstallConfig(config)[RELEASE_KEY];
    const known = resolvedRelease(typeof recorded === "string" ? recorded : undefined);
    if (known) return known;

    const announced = await readAppRuntimeLog(applicationId, ownerId, RELEASE_LOG_TAIL)
        .then(parseServerVersion)
        .catch(() => null);
    return announced ?? resolvedRelease(env.get("VERSION"));
}

/** A release somebody could compare, or null for one nobody has resolved yet.
 *  `LATEST` is not a release, it is a question. */
function resolvedRelease(value: string | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 && !wantsLatest(trimmed) ? trimmed : null;
}

/** Enough log to reach the version banner on a server that has just restarted,
 *  and not enough to be worth reading on anything that runs often. */
const RELEASE_LOG_TAIL = 400;
