/**
 * Creating a game server: turning what the manager asks for into an install.
 *
 * The dialog asks who the server is for, how many of them, and what game it
 * runs. Everything the image needs is worked out from that here - which template,
 * how much heap, which plugins carry the blueprint, whether Bedrock clients can
 * join a Java server - so the answer to "what did creating it actually do" lives
 * in one place rather than spread across a form.
 *
 * One entry point and one branch per game, because the games differ in what they
 * are made of and agree on what surrounds them: each is an install on a machine,
 * each gets a name on the operator's domain, and each is created as closed as its
 * game can be. The shared half is at the bottom of this file and no game gets its
 * own copy.
 *
 * The address is the last step and the only one allowed to fail quietly: a server
 * whose DNS could not be written is a working server that players reach by IP,
 * which is strictly better than no server.
 */

import { prisma } from "@polaris/db";
import * as fivemAccess from "./fivem/access";
import { joinAccess } from "./minecraft/access";
import { allocateArkPorts } from "./ark/create";
import { allocateFivemPort } from "./fivem/create";
import { allocateHytalePort } from "./hytale/create";
import { setGameHostname } from "./minecraft/address";
import * as memoryPlan from "./minecraft/memory-plan";
import { normalizeIdentifier } from "./fivem/players";
import { randomBytes, randomUUID } from "node:crypto";
import { ALLOW_LIST_KEY, withPlayer } from "./ark/access";
import * as polarisLogin from "./minecraft/polaris-login";
import { findGame, findSoftware, softwareSourceEnv, type GameDefinition } from "@polaris/core";
import { grantPlayerAccess } from "./minecraft/player-access";
import { arkServerEnv, expectedArkMemoryMb } from "./ark/config";
import { HYTALE_CATALOG_ID, HYTALE_PORT } from "./hytale/service";
import { mintConsolePassword, PENDING_SETUP_KEY } from "./fivem/service";
import {
    defaultModFor,
    enableLogin,
    PROJECTS_KEY,
    SOFTWARE_KEY,
    withJoinGuard
} from "./minecraft/join-guard";
import { applyAllowList, ARK_CATALOG_ID, mintJoinPassword } from "./ark/service";
import { ARK_PENDING_SETTINGS_KEY, RECOMMENDED_ARK_SETTINGS } from "./ark/settings";
import { isMapResourcePack, mapFor, pinnedRelease, type WorldMap } from "./minecraft/maps";
import {
    commonVersions,
    knownUnsupported,
    wantsLatest
} from "./minecraft/blueprint-version";
import {
    expectedFivemMemoryMb,
    fivemServerEnv,
    FIVEM_CATALOG_ID,
    FIVEM_CONTAINER_PORT
} from "./fivem/config";
import {
    formatProjectList,
    isPluginLoader,
    loaderForType,
    parseProjectList,
    projectSlug
} from "./minecraft/modrinth";
import type {
    CreateArkServerInput,
    CreateFivemServerInput,
    CreateGameServerInput,
    CreateHytaleServerInput,
    CreateMinecraftServerInput
} from "./games-schema";
import {
    DEFAULT_BIOME,
    DEFAULT_LEVEL_TYPE,
    levelEnvKey,
    levelTypeEnv,
    randomSeed,
    seedEnvKey
} from "./minecraft/world";
import {
    CROSSPLAY_PROJECTS,
    findBlueprint,
    formatMemory,
    GAME_BLUEPRINTS,
    requiredProjects,
    type GameBlueprint
} from "./minecraft/blueprints";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";

const { availableHostPort } = host.appsPortRegistry;
const { promptedEnvVars, findApp } = host.appsCatalog;
const { listEnvVars } = host.envVarService;
const { patchInstallConfig } = host.appsInstallConfig;
const { defaultInstallInput } = host.appsInstallDefaults;
const { publicAppUrl } = host.domainService;
const { installApp } = host.appsInstallService;
type InstallSeed = AppHostTypes["InstallSeed"];

/** The manifest each edition is created from. Both are internal: a server is
 *  created by the manager, never installed from the marketplace. */
const TEMPLATE_BY_EDITION = { java: "minecraft", bedrock: "minecraft-bedrock" } as const;

/** Bedrock clients speak to a Java+Geyser server on the Bedrock port. */
const BEDROCK_PORT = 19132;

export interface CreatedGameServer {
    readonly installedAppId: string;
    /** The address it will answer on, when a name could be written for it. */
    readonly hostname: string | null;
}

/** The key the install's config records which blueprint a server was built from
 *  under, so the server's own page can say what its game still needs and the
 *  reset dialog can open on what it is now. */
export const BLUEPRINT_KEY = "blueprintId";

/** The key the same config records which prebuilt map the server was built on,
 *  so its page can credit the map and the reset dialog can open on it. */
export const MAP_KEY = "mapId";

/**
 * The key it records the release the server was actually built on.
 *
 * Not the same as reading `VERSION` back off the container, which is very often
 * the literal `LATEST` and so says nothing about which Minecraft is on disk. What
 * is written here is the value after it was resolved, which is what a later reset
 * needs to know whether it is about to move the server to a different release -
 * and a release change is what makes the config the last one wrote unreadable.
 */
export const RELEASE_KEY = "mcRelease";

/**
 * The variable that carries a world for the container to fetch.
 *
 * The image downloads it once, on a start that finds no level of that name, and
 * extracts the folder holding `level.dat` into the one `LEVEL` names. So it is
 * both the download and the answer to "when": creating the server, and never
 * again unless the level is replaced. Written blank rather than left alone when
 * there is no map, or a server reset from a map to an ordinary world would fetch
 * the map again on its next restart.
 */
const WORLD_KEY = "WORLD";

/** What decides the game a Minecraft server plays and the map it plays it on.
 *  The same answers whether the server is being created or being reset to them. */
export interface MinecraftShape {
    readonly blueprintId: string;
    /** A prebuilt map of the blueprint's game to build on. Blank generates a
     *  world instead. */
    readonly mapId?: string;
    /** Java only: PAPER, FABRIC, ... The blueprint may pin it. */
    readonly software?: string;
    /** The one value that software asks for: the modpack, or the URL of the jar.
     *  Nothing for the software that asks for nothing. */
    readonly softwareSource?: string;
    /** A release, or LATEST for the newest the blueprint can run on. */
    readonly version?: string;
    /** Blank generates a random world. */
    readonly seed?: string;
    readonly levelType?: string;
    readonly biome?: string;
    /** How many are realistically on at once, which is what memory follows. */
    readonly concurrentPlayers: number;
    /** Whether Bedrock clients are meant to be able to join a Java server. */
    readonly crossplay: boolean;
}

/**
 * The environment a Minecraft server of a given shape runs on, merged over what
 * it already has.
 *
 * One function for creating a server and for resetting one, because they are the
 * same decision made twice: which plugins, which release, what the world is
 * generated from and how much heap it needs. Two copies of it is how a blueprint
 * ends up meaning one thing on a new server and something else on a reset one.
 *
 * A blueprint is a promise about the game this server plays and its plugins keep
 * it, so the release is not left to chance. Left on LATEST, the newest release
 * every one of them has a build for is pinned; asked for a release they cannot
 * run on, this refuses rather than installing nothing and handing back an
 * ordinary world. Only what Modrinth positively answered counts - an index that
 * could not be reached leaves the operator's own choice alone.
 *
 * A map, where one was chosen, is the stronger promise of the two and settles
 * every question the blueprint had already answered: the release it is pinned to,
 * the world the container fetches, the settings its game needs, and the plugins -
 * which it takes away rather than adds to, because a map carrying its own game
 * does not want a plugin providing a second one.
 */
export async function minecraftShapeEnv(
    edition: "java" | "bedrock",
    blueprint: GameBlueprint,
    shape: MinecraftShape,
    current: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
    const env = new Map(current);
    const map = mapFor(blueprint, shape.mapId);
    const versions = await blueprintVersions(blueprint, shape.crossplay, shape.software, map).catch(
        () => []
    );
    const pinned = pinnedRelease(map);
    const asked = (shape.version ?? "").trim();
    // A map pinned to a release is not a preference that a picker can override:
    // its datapack declares the release it was written for and its command blocks
    // are that release's syntax, so the alternative to refusing here is a server
    // that boots, loads the world, and silently does none of what the map does.
    if (pinned && !wantsLatest(asked) && asked !== pinned) {
        throw new Error(
            `${map?.name} only plays on Minecraft ${pinned}, so the server has to be built on it.`
        );
    }
    const wanted = pinned ?? (wantsLatest(asked) ? null : asked);
    if (wanted && knownUnsupported(versions, wanted)) {
        throw new Error(
            pinned
                ? `${map?.name} needs Minecraft ${pinned}, which this server's plugins have nothing built for.`
                : `${blueprint.name} has nothing built for Minecraft ${wanted}. The newest it runs on is ${versions[0]}.`
        );
    }
    env.set("VERSION", wanted ?? versions[0] ?? "LATEST");

    // The world the container fetches for itself, and the folder it lands in.
    // Blank for a generated world, so a server reset off a map stops fetching it.
    env.set(WORLD_KEY, map?.url ?? "");
    if (map) env.set(levelEnvKey(edition), map.id);

    // The seed and the shape of the world only ever apply to one that does not
    // exist yet, which is what a caller with no map is about to generate. Both are
    // written every time, blank included: a value left over from the last world
    // would quietly generate the previous one under the new one's name.
    //
    // A map is terrain that already exists, so none of this describes anything -
    // and it is put back to its default rather than left alone, which is not the
    // same as skipping it. A blueprint's flat lobby setting carried onto a map
    // server means `level-type=minecraft:flat` with no layers under it, and the
    // server reports that as an error on every boot of a world it was never going
    // to generate. Not writing it left whatever the server already had, so the
    // error outlived the change that was supposed to stop it.
    //
    // Except for a world too old to describe itself. Before 1.16 the generator was
    // not stored in the world at all, and a dedicated server that finds nothing
    // there falls back to its own `level-type` - so "the default" is not inert on
    // an old map, it is an instruction to generate ordinary terrain through it.
    //
    // A world nobody gave a seed for gets one minted here rather than an empty
    // value the image is left to interpret. An empty seed is not "surprise me"
    // to every image: somewhere between unset, empty and zero, and zero is a
    // valid seed that generates the same world every time. Which is exactly what
    // people saw - every new server, the same map.
    const generated = map === undefined;
    const chosen = shape.seed?.trim() ?? "";
    env.set(seedEnvKey(edition), generated ? chosen || randomSeed() : "");
    for (const [key, value] of Object.entries(
        map?.generator
            ? levelTypeEnv(
                  edition,
                  map.generator.levelType,
                  DEFAULT_BIOME,
                  map.generator.settings ?? ""
              )
            : levelTypeEnv(
                  edition,
                  generated
                      ? (shape.levelType ?? blueprint.levelType ?? DEFAULT_LEVEL_TYPE)
                      : DEFAULT_LEVEL_TYPE,
                  generated ? (shape.biome ?? DEFAULT_BIOME) : DEFAULT_BIOME
              )
    )) {
        env.set(key, value);
    }

    // Only the Java image runs a JVM to give a heap to.
    if (edition === "java") {
        javaSoftwareEnv(env, blueprint, shape, map);
        // The heap last, because it is decided by the line above it: a mod
        // loader costs about a gigabyte before a single mod is installed on it,
        // and each mod on the list costs again. A server sized as if it were
        // vanilla is one that runs out of memory while generating the world.
        env.set("MEMORY", formatMemory(shapeHeapMb(env, blueprint, shape.concurrentPlayers)));
    }
    for (const [key, value] of Object.entries(blueprint.env ?? {})) env.set(key, value);
    // Last, over the blueprint's own: where the two disagree the map is the one
    // that has to be right, because it is the thing people will be standing in.
    for (const [key, value] of Object.entries(map?.env ?? {})) env.set(key, value);
    for (const [key, value] of Object.entries(resourcePackEnv(map, env.get("RESOURCE_PACK"))))
        env.set(key, value);
    return env;
}

/**
 * The pack a map needs the client to load, and the clearing up after one that no
 * longer applies.
 *
 * Only a pack Polaris put there is ever taken away. An operator who set their own
 * under Settings did so deliberately, and a change of map is not them asking for
 * it to be removed - so the blank is written for the map's own packs and nothing
 * else. The hash is not optional: the game refuses to reuse a downloaded pack it
 * cannot identify, so leaving it behind is every player fetching it again on
 * every join.
 */
function resourcePackEnv(
    map: WorldMap | undefined,
    current: string | undefined
): Record<string, string> {
    if (map?.resourcePack)
        return { RESOURCE_PACK: map.resourcePack.url, RESOURCE_PACK_SHA1: map.resourcePack.sha1 };
    return isMapResourcePack(current) ? { RESOURCE_PACK: "", RESOURCE_PACK_SHA1: "" } : {};
}

/**
 * Everything one piece of software can ask the image for, blank.
 *
 * Written before the chosen software writes its own, so changing what a server
 * runs takes the previous one with it. Without this a server moved from a modpack
 * to Paper keeps `MODRINTH_MODPACK` and installs the pack over the top of it on
 * the next start, which reads as Paper not working.
 */
const SOFTWARE_EXTRA_KEYS: Readonly<Record<string, string>> = {
    BUILD_FROM_SOURCE: "",
    MODRINTH_MODPACK: "",
    CUSTOM_SERVER: ""
};

/** The software a Java server runs and the projects its list carries, written
 *  onto `env`. Shared by building a server and quoting its heap, so the two agree
 *  on what the list ends up holding. */
function javaSoftwareEnv(
    env: Map<string, string>,
    blueprint: GameBlueprint,
    shape: Pick<MinecraftShape, "software" | "softwareSource" | "crossplay">,
    map: WorldMap | undefined
): void {
    // What the operator chose, then what the blueprint insists on: a blueprint
    // that needs Paper is not a suggestion, it is what its plugins load into.
    const software = blueprint.software ?? shape.software ?? "PAPER";
    env.set(SOFTWARE_KEY, software);
    // What this software needs set beyond its own name - Spigot has to be
    // compiled because its downloads stopped answering machines - and the one
    // value the operator was asked for. Both are written every time, blank
    // included: a server moved off a modpack keeps fetching it otherwise.
    for (const [key, value] of Object.entries(SOFTWARE_EXTRA_KEYS)) env.set(key, value);
    for (const [key, value] of Object.entries(findSoftware(software)?.env ?? {})) env.set(key, value);
    for (const [key, value] of Object.entries(
        softwareSourceEnv(software, shape.softwareSource ?? "")
    ))
        env.set(key, value);
    // Polaris's login mod, on a server being reset that already runs it: kept
    // when it has a build for where the server is going, taken off when it
    // does not - and then the project guard below takes its place.
    const mod = polarisLogin.modMovedTo(env, software, env.get("VERSION") ?? "");
    for (const [key, value] of mod ?? []) env.set(key, value);
    env.set(
        PROJECTS_KEY,
        protectionFor(
            "java",
            software,
            projectList(blueprint, env.get(PROJECTS_KEY), shape.crossplay, map),
            polarisLogin.loginOn(env)
        )
    );
}

/** The heap a Java server of this shape is given, from the software and the
 *  projects already on `env`, never past the default ceiling: a figure planned
 *  for a thousand people is a container that cannot start. */
export function shapeHeapMb(
    env: ReadonlyMap<string, string>,
    blueprint: GameBlueprint,
    concurrentPlayers: number
): number {
    return memoryPlan.clampHeapMb(
        memoryPlan.plannedHeapMb({
            concurrentPlayers,
            weight: blueprint.weight,
            loader: loaderForType(env.get(SOFTWARE_KEY) ?? "") ?? "",
            software: env.get(SOFTWARE_KEY) ?? "",
            mods: parseProjectList(env.get(PROJECTS_KEY) ?? "").length
        }),
        { ceilingMb: memoryPlan.DEFAULT_CEILING_MB }
    );
}

/** A heap bounded by what the machine it is going onto can still spare. */
async function heapForMachine(ownerId: string, machineId: string, heapMb: number): Promise<number> {
    const { listGameMachines } = await import("./games-service");
    const machines = await listGameMachines(ownerId, false).catch(() => []);
    return memoryPlan.clampHeapMb(heapMb, {
        ceilingMb: memoryPlan.DEFAULT_CEILING_MB,
        ...memoryPlan.machineHeapBounds(machines.find((entry) => entry.id === machineId))
    });
}

/**
 * The heap a server would be given, for the create and reset screens to quote
 * before anything is written.
 *
 * Built by the same steps that build the server, so the figure reflects the
 * software actually chosen and every project the list ends up carrying - the
 * crossplay pair, the protection, the login - rather than the blueprint alone.
 * A reset starts from the server's own list, which is where a mod somebody
 * installed afterwards lives. Null for an edition that runs no JVM.
 */
export async function expectedMinecraftHeapMb(
    ownerId: string,
    input: {
        readonly edition: "java" | "bedrock";
        readonly blueprintId: string;
        readonly software?: string;
        readonly softwareSource?: string;
        readonly mapId?: string;
        readonly crossplay: boolean;
        readonly concurrentPlayers: number;
        /** The machine a new server is going onto. */
        readonly serverId?: string;
        /** The server being reset, whose list the new one starts from. */
        readonly installedAppId?: string;
    }
): Promise<number | null> {
    if (input.edition !== "java") return null;
    const blueprint = blueprintFor(input.edition, input.blueprintId);
    let env: Map<string, string>;
    if (input.installedAppId) {
        const install = await prisma.installedApp.findFirst({
            where: { id: input.installedAppId, ownerId, status: { not: "removed" } },
            select: { applicationId: true }
        });
        if (!install?.applicationId) return null;
        const vars = await listEnvVars("application", install.applicationId, ownerId);
        env = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
        env.set(PROJECTS_KEY, withoutBlueprintProjects(env.get(PROJECTS_KEY)));
    } else {
        const manifest = findApp(TEMPLATE_BY_EDITION[input.edition]);
        if (!manifest) return null;
        env = new Map(
            defaultInstallInput(manifest, input.serverId).env.map((entry) => [
                entry.key,
                entry.value
            ])
        );
    }
    javaSoftwareEnv(
        env,
        blueprint,
        {
            ...(input.software ? { software: input.software } : {}),
            ...(input.softwareSource ? { softwareSource: input.softwareSource } : {}),
            crossplay: input.crossplay
        },
        mapFor(blueprint, input.mapId)
    );
    const heapMb = shapeHeapMb(env, blueprint, input.concurrentPlayers);
    if (!input.installedAppId) return heapForMachine(ownerId, input.serverId ?? "local", heapMb);
    const { resetHeapMb } = await import("./games-memory");
    return resetHeapMb(ownerId, input.installedAppId, heapMb);
}

/** The blueprint a shape names, refusing one this edition cannot be built from. */
export function blueprintFor(edition: "java" | "bedrock", blueprintId: string): GameBlueprint {
    const blueprint = findBlueprint(blueprintId);
    if (!blueprint) throw new Error("Unknown blueprint");
    if (!blueprint.editions.includes(edition))
        throw new Error("That blueprint is not available for this edition");
    return blueprint;
}

export async function createGameServer(
    ownerId: string,
    actorId: string,
    input: CreateGameServerInput
): Promise<CreatedGameServer> {
    if (input.game === "ark") return createArkServer(ownerId, actorId, input);
    if (input.game === "fivem") return createFivemServer(ownerId, actorId, input);
    if (input.game === "hytale") return createHytaleServer(ownerId, actorId, input);
    return createMinecraftServer(ownerId, actorId, input);
}

async function createMinecraftServer(
    ownerId: string,
    actorId: string,
    input: CreateMinecraftServerInput & {
        /** The settings a saved template carries, already read and filtered. */
        readonly templateSettings?: Record<string, string>;
    }
): Promise<CreatedGameServer> {
    const catalogId = TEMPLATE_BY_EDITION[input.edition];
    const manifest = findApp(catalogId);
    if (!manifest) throw new Error("That edition is not available");
    const blueprint = blueprintFor(input.edition, input.blueprintId);

    const base = defaultInstallInput(manifest, input.serverId);
    const env = await minecraftShapeEnv(
        input.edition,
        blueprint,
        {
            blueprintId: input.blueprintId,
            ...(input.mapId ? { mapId: input.mapId } : {}),
            ...(input.software ? { software: input.software } : {}),
            ...(input.softwareSource ? { softwareSource: input.softwareSource } : {}),
            version: input.version,
            ...(input.seed ? { seed: input.seed } : {}),
            ...(input.levelType ? { levelType: input.levelType } : {}),
            ...(input.biome ? { biome: input.biome } : {}),
            concurrentPlayers: input.concurrentPlayers,
            crossplay: input.crossplay
        },
        new Map(base.env.map((entry) => [entry.key, entry.value]))
    );
    env.set("MAX_PLAYERS", String(input.maxPlayers));
    if (input.edition === "java") {
        const heapMb = shapeHeapMb(env, blueprint, input.concurrentPlayers);
        env.set("MEMORY", formatMemory(await heapForMachine(ownerId, input.serverId, heapMb)));
    }

    // A server somebody already built, applied over the blueprint's answer and
    // under the ones below it. Over, because the whole point of saving one is that
    // its owner disagreed with a default; under, because nothing saved a month ago
    // is allowed to decide who may join this server or which port it takes.
    for (const [key, value] of Object.entries(input.templateSettings ?? {})) env.set(key, value);

    // Who the server lets in, decided before it boots rather than left to a list
    // that starts enforced and empty. Last over the blueprint, because no blueprint
    // is allowed to produce a server nobody can join.
    for (const [key, value] of Object.entries(joinAccess(input.edition, input.ownerPlayer).env)) {
        env.set(key, value);
    }

    // Polaris login, wherever this software and release have a build. Last over
    // the template for the same reason as the access above: a login is not a
    // preference a saved server passes on, and the template may carry the project
    // guard this replaces.
    const seed = await loginSeed(env);

    // Crossplay is Geyser listening on the Bedrock port inside the same container,
    // so that port has to be published as well - one service, two doors. Geyser's
    // own default is 19132; the host side takes the next free one.
    const extra = input.crossplay
        ? [
              {
                  host: await availableHostPort(BEDROCK_PORT, "udp"),
                  container: BEDROCK_PORT,
                  protocol: "udp" as const
              }
          ]
        : undefined;

    const install = await installApp(
        ownerId,
        actorId,
        {
            ...base,
            name: input.name,
            env: [...env.entries()].map(([key, value]) => ({ key, value }))
        },
        extra ? { extra } : undefined,
        seed
    );

    // Which game this server was built to play and on what, so its own page can
    // say what that game still needs of it, credit the map it is standing on, and
    // a reset can start from what it is now.
    await patchInstallConfig(install.installedAppId, {
        [BLUEPRINT_KEY]: blueprint.id,
        [MAP_KEY]: input.mapId ?? "",
        [RELEASE_KEY]: env.get("VERSION") ?? "",
        // New servers are planned from the start: the heap follows the mods and
        // the people, so nobody has to notice that installing a mod loader made
        // the figure chosen today wrong. Servers made before this keep theirs -
        // see `memory-plan.ts` for why that asymmetry is deliberate.
        [memoryPlan.MEMORY_MODE_KEY]: "auto"
    });

    // The address half of the pair, which the game has nowhere to keep. The image
    // was already handed the username; this is what makes the name mean one line
    // rather than anyone holding the account.
    await grantPlayerAccess(ownerId, install.installedAppId, actorId, {
        username: input.ownerPlayer,
        address: input.ownerAddress,
        note: "Created this server"
    });

    const hostname = await attachHostname(ownerId, install.installedAppId, input, {
        srv: input.edition === "java"
    });
    return { installedAppId: install.installedAppId, hostname };
}

/**
 * What a new server needs to run Polaris login from its first boot, or undefined
 * when it will not run it.
 *
 * The mod names its server by the install's id and proves it with a token, and
 * neither exists until the install does - so the id is chosen here and the
 * install is created with it. The project guard comes off the list in the same
 * step, since two logins would ask a player twice.
 *
 * Only where Polaris has a public address: the server fetches the mod from it and
 * does not start while it cannot reach it, and a LAN name such as
 * `polaris.local` does not resolve inside a container. Elsewhere the server keeps
 * the Modrinth guard, and the card offers the switch.
 */
async function loginSeed(env: Map<string, string>): Promise<InstallSeed | undefined> {
    const file = defaultModFor(env);
    if (file === null) return undefined;
    const baseUrl = await publicAppUrl().catch(() => null);
    if (baseUrl === null) return undefined;
    const installedAppId = randomUUID();
    const written = enableLogin({
        current: env,
        baseUrl,
        installedAppId,
        file,
        token: randomBytes(32).toString("hex")
    });
    env.set(PROJECTS_KEY, written.get(PROJECTS_KEY) ?? "");
    return { installedAppId, env: polarisLogin.envWrites(written) };
}

/**
 * Create an ARK server: three ports, two passwords and a closed door.
 *
 * The ports are allocated as a run and handed to the image, because ARK's raw
 * socket has to sit exactly one above its game port on the player's side of the
 * mapping - see `ark/create.ts`. The passwords are the reason this cannot be a
 * plain install: the image ships a default join password and a default admin
 * password, both printed in its own documentation, and a server created on either
 * of them is open to anybody who has read it.
 *
 * The allow list is recorded rather than applied. There is no server to tell yet -
 * a new one spends its first while downloading about thirty gigabytes - so the
 * person creating it is written down as allowed, and the first sweep that finds the
 * server answering hands them over.
 */
async function createArkServer(
    ownerId: string,
    actorId: string,
    input: CreateArkServerInput
): Promise<CreatedGameServer> {
    const manifest = findApp(ARK_CATALOG_ID);
    if (!manifest) throw new Error("ARK is not available");

    const ports = await allocateArkPorts();
    const base = defaultInstallInput(manifest, input.serverId);
    // Only the values the operator actually chose. An empty string here is not the
    // same as an unset variable: the image writes each one it holds onto the
    // server's command line, and an empty mod list arrives as a bare `?GameModIds`.
    const env = new Map(
        base.env.filter((entry) => entry.value.length > 0).map((entry) => [entry.key, entry.value])
    );
    // Minted here rather than by the install's `generated` path, which produces 48
    // hex characters - a length ARK refuses at the enablecheats prompt, leaving the
    // server's own admin locked out of it. Same shape as the join password, which
    // is a shape the game demonstrably takes.
    for (const [key, value] of Object.entries(arkServerEnv(input, ports, mintJoinPassword())))
        env.set(key, value);

    const install = await installApp(
        ownerId,
        actorId,
        {
            ...base,
            name: input.name,
            env: [...env.entries()].map(([key, value]) => ({ key, value }))
        },
        {
            primary: { host: ports.game, container: ports.game, protocol: "udp" },
            extra: [
                { host: ports.raw, container: ports.raw, protocol: "udp" },
                { host: ports.query, container: ports.query, protocol: "udp" }
            ]
        }
    );

    await patchInstallConfig(install.installedAppId, {
        [ALLOW_LIST_KEY]: withPlayer(
            [],
            { steamId: input.ownerSteamId, label: input.ownerLabel?.trim() || "You" },
            new Date().toISOString()
        ),
        // What the machine picker bills this server at. ARK has no heap to set, so
        // without this a machine running four of them looks empty on the form that
        // decides where the fifth goes.
        memoryMb: expectedArkMemoryMb(input.concurrentPlayers),
        // The handful of settings that are only off because ARK's defaults were
        // written for public servers a decade ago: a map that shows you where you
        // are, a camera you can turn round, a crosshair, and a brightness slider so
        // the nights are playable. Recorded rather than applied for the same reason
        // the allow list is - there is no server yet - and handed over by the same
        // sweep, which leaves anything the operator has since chosen alone.
        [ARK_PENDING_SETTINGS_KEY]: RECOMMENDED_ARK_SETTINGS
    });
    // Almost certainly too early - the server is still installing - but free when
    // it is, and the difference between "the sweep will get to it" and "it is
    // already done" is the whole first evening on a server somebody just made.
    await applyAllowList(ownerId, install.installedAppId).catch(() => 0);

    const hostname = await attachHostname(ownerId, install.installedAppId, input, { srv: false });
    return { installedAppId: install.installedAppId, hostname };
}

/**
 * Create a FiveM server.
 *
 * Two things are unusual about this one and both are the game's. The key is a
 * value nobody but its owner can get - it is issued per machine at keymaster and
 * the server refuses to start without it - so it is asked for on the form and
 * written straight into the deploy's environment.
 *
 * The other is that almost nothing about the server can be decided here. FiveM
 * keeps every setting in a config file that the image writes on the container's
 * very first start, which has not happened yet: there is no file to edit at the
 * moment the server is created. So what it was created with is written down and
 * handed over by the first sweep that finds the container up, exactly as ARK's
 * allow list is - see `applyPendingSetup`.
 */
async function createFivemServer(
    ownerId: string,
    actorId: string,
    input: CreateFivemServerInput
): Promise<CreatedGameServer> {
    const manifest = findApp(FIVEM_CATALOG_ID);
    if (!manifest) throw new Error("FiveM is not available");

    const port = await allocateFivemPort();
    const base = defaultInstallInput(manifest, input.serverId);
    // Only the values the operator actually chose, plus the two the server cannot
    // start without. An empty string is not the same as an unset variable here:
    // the image's own entrypoint branches on whether each is set at all.
    const env = new Map(
        base.env.filter((entry) => entry.value.length > 0).map((entry) => [entry.key, entry.value])
    );
    for (const [key, value] of Object.entries(
        fivemServerEnv(input.licenseKey, mintConsolePassword())
    )) {
        env.set(key, value);
    }

    const install = await installApp(
        ownerId,
        actorId,
        {
            ...base,
            name: input.name,
            env: [...env.entries()].map(([key, value]) => ({ key, value }))
        },
        {
            // One number published twice. A FiveM client begins over TCP and plays
            // over UDP, on the same port, and an address carries only the one.
            primary: { host: port, container: FIVEM_CONTAINER_PORT, protocol: "tcp" },
            extra: [{ host: port, container: FIVEM_CONTAINER_PORT, protocol: "udp" }]
        }
    );

    const now = new Date().toISOString();
    const owner = input.ownerIdentifier
        ? {
              identifier: normalizeIdentifier(input.ownerIdentifier),
              label: input.ownerLabel?.trim() || "You"
          }
        : null;
    await patchInstallConfig(install.installedAppId, {
        [fivemAccess.ALLOW_LIST_KEY]: owner ? fivemAccess.withAllowed([], owner, now) : [],
        [fivemAccess.ADMIN_LIST_KEY]: owner ? fivemAccess.withAdmin([], owner, now) : [],
        // Never closed without somebody on the list: the schema refuses that
        // combination, and a server nobody at all can join is not a state worth
        // being able to reach.
        [fivemAccess.EXCLUSIVE_JOIN_KEY]: owner ? input.exclusiveJoin : false,
        // What the machine picker bills this server at. FiveM has no heap to set,
        // so without this a machine running four of them looks empty on the form
        // that decides where the fifth goes.
        memoryMb: expectedFivemMemoryMb(input.concurrentPlayers),
        // FiveM keeps its slot count in the config file rather than in the
        // environment, and that file does not exist yet - so the list is told here
        // and a stopped server can still say what size it is.
        slots: input.maxPlayers,
        [PENDING_SETUP_KEY]: {
            settings: {
                sv_hostname: input.sessionName,
                sv_maxclients: String(input.maxPlayers),
                onesync: input.onesync,
                // The two that are only off because FiveM's defaults were written
                // for a public server: mods that let a player run anything they
                // like, and a log that prints everybody's address.
                sv_scriptHookAllowed: "0",
                sv_endpointprivacy: "true"
            }
        }
    });

    const hostname = await attachHostname(ownerId, install.installedAppId, input, { srv: false });
    return { installedAppId: install.installedAppId, hostname };
}

/**
 * A Hytale server: a machine, a volume and an address, and then it waits.
 *
 * Nothing is installed into it here, and that is the game rather than an omission
 * - the server files are handed out by Hytale to the account that owns the game,
 * so the last step belongs to whoever created this. The container says which file
 * it is waiting for and starts by itself when both arrive, and the panel says the
 * same thing with the folder one press away.
 */
async function createHytaleServer(
    ownerId: string,
    actorId: string,
    input: CreateHytaleServerInput
): Promise<CreatedGameServer> {
    const manifest = findApp(HYTALE_CATALOG_ID);
    if (!manifest) throw new Error("Hytale is not available");

    const port = await allocateHytalePort();
    const base = defaultInstallInput(manifest, input.serverId);
    const env = new Map(base.env.map((entry) => [entry.key, entry.value]));
    env.set("HYTALE_MEMORY", input.memory);

    const install = await installApp(
        ownerId,
        actorId,
        {
            ...base,
            name: input.name,
            env: [...env.entries()].map(([key, value]) => ({ key, value }))
        },
        // UDP alone. A Hytale client speaks QUIC and nothing else, and a TCP
        // publication here would be a port nobody ever connects to.
        { primary: { host: port, container: HYTALE_PORT, protocol: "udp" } }
    );

    await patchInstallConfig(install.installedAppId, {
        // What the machine picker bills this server at, since there is no heap
        // setting for it to read: without this a machine running four of them
        // looks empty to the form deciding where the fifth goes.
        memoryMb: memoryMbOf(input.memory),
        slots: input.maxPlayers
    });

    const hostname = await attachHostname(ownerId, install.installedAppId, input, { srv: false });
    return { installedAppId: install.installedAppId, hostname };
}

/** `3G` and `4096M` as the number the machine picker adds up. */
function memoryMbOf(memory: string): number {
    const amount = Number.parseInt(memory, 10);
    if (!Number.isFinite(amount)) return 3072;
    return memory.trim().toUpperCase().endsWith("G") ? amount * 1024 : amount;
}

/**
 * The releases a server of this shape could be built on, newest first.
 *
 * Only what it has to install decides it - the blueprint's own plugins, and the
 * crossplay pair when Bedrock players are meant to get in. The protection every
 * server gets is deliberately not counted: those are optional entries, and
 * letting an anticheat that has not been rebuilt yet hold every new server back a
 * release would be a worse failure than the one this exists to prevent.
 *
 * Empty means unconstrained, not unsupported: a blueprint that installs nothing,
 * or a Modrinth nobody could reach.
 */
export async function blueprintVersions(
    blueprint: GameBlueprint,
    crossplay = false,
    software?: string,
    map?: WorldMap
): Promise<string[]> {
    // Asked about the software the plugins will actually be loaded into, because
    // that is what decides whether a build for a release exists at all.
    const loader = loaderForType(blueprint.software ?? software ?? "PAPER");
    return commonVersions(
        requiredProjects(blueprint, crossplay, map?.projects),
        loader ?? undefined
    );
}

/** The newest release a blueprint can run on, or null when nothing constrains it. */
export async function blueprintVersion(
    blueprint: GameBlueprint,
    crossplay = false
): Promise<string | null> {
    return (await blueprintVersions(blueprint, crossplay))[0] ?? null;
}

/** The blueprint's plugins - or the map's instead of them - on top of the
 *  protection every server gets, plus the crossplay pair when Bedrock players are
 *  meant to be able to join. */
function projectList(
    blueprint: GameBlueprint,
    current: string | undefined,
    crossplay: boolean,
    map?: WorldMap
): string {
    const projects = new Set(parseProjectList(current ?? ""));
    for (const project of requiredProjects(blueprint, crossplay, map?.projects))
        projects.add(project);
    return formatProjectList([...projects]);
}

/**
 * What a modded server is given instead of the plugins.
 *
 * Claims, and only claims. A claim is the answer to the thing people actually
 * lose a server over - somebody walks into a base that is not theirs and empties
 * it - and this one carries no dependencies at all, which is what makes it safe
 * to hand every server without asking.
 *
 * Nothing here is an anticheat, because for a modded server there is none to
 * give: every anticheat worth the name is a Bukkit plugin, and the one project
 * claiming to cover NeoForge ships a Sponge jar and requires PacketEvents, which
 * publishes no build for it. A required dependency the image cannot resolve ends
 * the boot rather than skipping the mod, so naming one here would trade a server
 * with no anticheat for a server that does not start.
 *
 * Block history is left out for the same reason and not for want of a candidate:
 * GriefLogger fits and is widely run, but it requires two libraries, and "?" only
 * ever made the project itself skippable - never what it cannot run without. It
 * is a good thing to install deliberately, on a release somebody has checked, and
 * a bad thing to seed onto every server on every release.
 */
const MODDED_PROTECTION = ["open-parties-and-claims?"] as const;

/** The projects the manifest seeds only onto a server that runs plugins, as
 *  slugs - read from the manifest rather than repeated here, so the seed and the
 *  thing that takes it away again cannot drift apart. */
function seededPlugins(edition: "java" | "bedrock"): Set<string> {
    const manifest = findApp(TEMPLATE_BY_EDITION[edition]);
    const field = (manifest?.template?.env ?? []).find(
        (entry) => entry.key === PROJECTS_KEY && entry.pluginServersOnly
    );
    return new Set(
        parseProjectList(field?.default ?? "")
            .map(projectSlug)
            .filter((slug): slug is string => slug !== null)
            .map((slug) => slug.toLowerCase())
    );
}

/**
 * The protection a server actually gets, once its software is known.
 *
 * The manifest already says its protection seed is for servers that run plugins,
 * and an install assembled from manifest defaults honours that. This path is not
 * assembled that way: it builds the environment itself and passes the mod list
 * explicitly, which downstream is indistinguishable from a value the operator
 * typed - and a typed value is kept, deliberately. So a modded server created
 * here was handed three Bukkit plugins: two that Modrinth has never heard of for
 * it, and one jar it cannot boot on.
 *
 * Only what Polaris seeded is taken back, plus a password project meant for the
 * other loader (see `withJoinGuard`). Anything else on the list belongs to
 * whoever put it there, which on a modded server is every mod on it.
 *
 * `modOn` is a server closed by Polaris's own login mod, which takes no password
 * project beside it.
 */
export function protectionFor(
    edition: "java" | "bedrock",
    software: string,
    current: string,
    modOn = false
): string {
    const loader = loaderForType(software);
    if (loader && isPluginLoader(loader)) return withJoinGuard(current, software, modOn);
    // Software nothing on Modrinth loads into gets nothing put on its list. A
    // modpack brings its own mods and its own versions of them, a custom jar is
    // whatever somebody built, and a lobby server has no world to protect - so
    // the modded protection below would be three downloads the server either
    // ignores or refuses to boot past. What is already on the list is left alone:
    // it is somebody else's decision, not this one.
    if (!loader) return current;
    const seeded = seededPlugins(edition);
    const modded = new Set(MODDED_PROTECTION.map((entry) => projectSlug(entry)?.toLowerCase()));
    const kept = parseProjectList(current).filter((entry) => {
        const slug = projectSlug(entry)?.toLowerCase();
        // The modded set is appended below, so an entry already naming one of them
        // is dropped here rather than written twice with two different suffixes.
        return slug === undefined || slug === null || (!seeded.has(slug) && !modded.has(slug));
    });
    return withJoinGuard(formatProjectList([...kept, ...MODDED_PROTECTION]), software, modOn);
}

/**
 * Plugins Polaris used to put on a server's list and no longer does.
 *
 * Floodgate went on every crossplay server until it turned out GeyserMC
 * publishes no Paper build of it on Modrinth, which made it an entry the image
 * could never satisfy. A server that still carries it is one a reset should take
 * it off, so this is not just history - it is what stops the previous answer
 * outliving the correction.
 */
const RETIRED_PROJECTS = ["floodgate"] as const;

/**
 * A plugin list with every blueprint's own plugins taken back out of it.
 *
 * What a reset needs, and only a reset: rebuilding the list around the new
 * blueprint has to drop the old one's plugin, or a server reset from Bed wars to
 * Survival is a survival server still running BedWars1058. Every blueprint's
 * projects go, not just the one recorded against the server - the record is a
 * convenience and the list on the container is the truth.
 *
 * Anything else on the list stays. Somebody who installed a map plugin from the
 * Mods screen is not asking for it to be uninstalled by a change of game.
 */
/**
 * Every plugin Polaris installs on a server of its own accord.
 *
 * The list a reset is allowed to take things off, and - because taking a plugin off
 * the list has never taken it off the disk - the list a reset is allowed to remove
 * files for. Anything outside it was installed by somebody, and is theirs.
 */
export const OWNED_PROJECTS: readonly string[] = [
    ...new Set(
        [
            ...GAME_BLUEPRINTS.flatMap((blueprint) => blueprint.projects),
            ...CROSSPLAY_PROJECTS,
            ...RETIRED_PROJECTS
        ]
            .map(projectSlug)
            .filter((slug): slug is string => slug !== null)
            .map((slug) => slug.toLowerCase())
    )
];

export function withoutBlueprintProjects(current: string | undefined): string {
    const owned = new Set(OWNED_PROJECTS);
    return formatProjectList(
        parseProjectList(current ?? "").filter((entry) => {
            const slug = projectSlug(entry);
            return slug === null || !owned.has(slug.toLowerCase());
        })
    );
}

/**
 * Give the server a name on the operator's domain. The same act as changing it
 * later, so it is the same code: see `setGameHostname`. Silent when there is no
 * domain to put it on - the server still has the address it was published at.
 */
async function attachHostname(
    ownerId: string,
    installedAppId: string,
    input: CreateGameServerInput,
    dns: { srv: boolean }
): Promise<string | null> {
    const game: GameDefinition | undefined = findGame(input.game);
    return setGameHostname(ownerId, installedAppId, {
        name: input.name,
        ...(input.subdomain ? { subdomain: input.subdomain } : {}),
        srv: dns.srv,
        ...(game ? { gameLabel: game.domainLabel } : {})
    });
}

/** The settings the create dialog shows before a world exists, for one edition. */
export function upfrontFields(catalogId: string) {
    const manifest = findApp(catalogId);
    if (!manifest) return [];
    return promptedEnvVars(manifest).filter((field) =>
        [SOFTWARE_KEY, "VERSION"].includes(field.key)
    );
}
