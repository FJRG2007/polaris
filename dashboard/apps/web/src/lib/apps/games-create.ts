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
 * are made of and agree on what surrounds them: both are an install on a machine,
 * both get a name on the operator's domain, and both are created closed. The
 * shared half is at the bottom of this file and neither game gets its own copy.
 *
 * The address is the last step and the only one allowed to fail quietly: a server
 * whose DNS could not be written is a working server that players reach by IP,
 * which is strictly better than no server.
 */

import { installApp } from "@/lib/apps/install-service";
import { joinAccess } from "@/lib/apps/minecraft/access";
import { allocateArkPorts } from "@/lib/apps/ark/create";
import { availableHostPort } from "@/lib/apps/port-registry";
import { promptedEnvVars, findApp } from "@/lib/apps/catalog";
import { setGameHostname } from "@/lib/apps/minecraft/address";
import { patchInstallConfig } from "@/lib/apps/install-config";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import { ALLOW_LIST_KEY, withPlayer } from "@/lib/apps/ark/access";
import { grantPlayerAccess } from "@/lib/apps/minecraft/player-access";
import { findGame, type GameDefinition } from "@/lib/apps/games-catalog";
import { arkServerEnv, expectedArkMemoryMb } from "@/lib/apps/ark/config";
import { applyAllowList, ARK_CATALOG_ID, mintJoinPassword } from "@/lib/apps/ark/service";
import { ARK_PENDING_SETTINGS_KEY, RECOMMENDED_ARK_SETTINGS } from "@/lib/apps/ark/settings";
import { isMapResourcePack, mapFor, pinnedRelease, type WorldMap } from "@/lib/apps/minecraft/maps";
import { commonVersions, knownUnsupported, wantsLatest } from "@/lib/apps/minecraft/blueprint-version";
import { formatProjectList, loaderForType, parseProjectList, projectSlug } from "@/lib/apps/minecraft/modrinth";
import type {
    CreateArkServerInput,
    CreateGameServerInput,
    CreateMinecraftServerInput
} from "@/lib/apps/games-schema";
import {
    DEFAULT_BIOME,
    DEFAULT_LEVEL_TYPE,
    levelEnvKey,
    levelTypeEnv,
    randomSeed,
    seedEnvKey
} from "@/lib/apps/minecraft/world";
import {
    CROSSPLAY_PROJECTS,
    findBlueprint,
    formatMemory,
    GAME_BLUEPRINTS,
    recommendedMemoryMb,
    requiredProjects,
    type GameBlueprint
} from "@/lib/apps/minecraft/blueprints";

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
    const versions = await blueprintVersions(blueprint, shape.crossplay, shape.software, map).catch(() => []);
    const pinned = pinnedRelease(map);
    const asked = (shape.version ?? "").trim();
    // A map pinned to a release is not a preference that a picker can override:
    // its datapack declares the release it was written for and its command blocks
    // are that release's syntax, so the alternative to refusing here is a server
    // that boots, loads the world, and silently does none of what the map does.
    if (pinned && !wantsLatest(asked) && asked !== pinned) {
        throw new Error(`${map?.name} only plays on Minecraft ${pinned}, so the server has to be built on it.`);
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
            ? levelTypeEnv(edition, map.generator.levelType, DEFAULT_BIOME, map.generator.settings ?? "")
            : levelTypeEnv(
                  edition,
                  generated ? (shape.levelType ?? blueprint.levelType ?? DEFAULT_LEVEL_TYPE) : DEFAULT_LEVEL_TYPE,
                  generated ? (shape.biome ?? DEFAULT_BIOME) : DEFAULT_BIOME
              )
    )) {
        env.set(key, value);
    }

    // Only the Java image runs a JVM to give a heap to.
    if (edition === "java") {
        env.set("MEMORY", formatMemory(recommendedMemoryMb(shape.concurrentPlayers, blueprint.weight)));
        // What the operator chose, then what the blueprint insists on: a blueprint
        // that needs Paper is not a suggestion, it is what its plugins load into.
        env.set("TYPE", blueprint.software ?? shape.software ?? "PAPER");
        env.set("MODRINTH_PROJECTS", projectList(blueprint, env.get("MODRINTH_PROJECTS"), shape.crossplay, map));
    }
    for (const [key, value] of Object.entries(blueprint.env ?? {})) env.set(key, value);
    // Last, over the blueprint's own: where the two disagree the map is the one
    // that has to be right, because it is the thing people will be standing in.
    for (const [key, value] of Object.entries(map?.env ?? {})) env.set(key, value);
    for (const [key, value] of Object.entries(resourcePackEnv(map, env.get("RESOURCE_PACK")))) env.set(key, value);
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
function resourcePackEnv(map: WorldMap | undefined, current: string | undefined): Record<string, string> {
    if (map?.resourcePack) return { RESOURCE_PACK: map.resourcePack.url, RESOURCE_PACK_SHA1: map.resourcePack.sha1 };
    return isMapResourcePack(current) ? { RESOURCE_PACK: "", RESOURCE_PACK_SHA1: "" } : {};
}

/** The blueprint a shape names, refusing one this edition cannot be built from. */
export function blueprintFor(edition: "java" | "bedrock", blueprintId: string): GameBlueprint {
    const blueprint = findBlueprint(blueprintId);
    if (!blueprint) throw new Error("Unknown blueprint");
    if (!blueprint.editions.includes(edition)) throw new Error("That blueprint is not available for this edition");
    return blueprint;
}

export async function createGameServer(
    ownerId: string,
    actorId: string,
    input: CreateGameServerInput
): Promise<CreatedGameServer> {
    return input.game === "ark"
        ? createArkServer(ownerId, actorId, input)
        : createMinecraftServer(ownerId, actorId, input);
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
        { ...base, name: input.name, env: [...env.entries()].map(([key, value]) => ({ key, value })) },
        extra ? { extra } : undefined
    );

    // Which game this server was built to play and on what, so its own page can
    // say what that game still needs of it, credit the map it is standing on, and
    // a reset can start from what it is now.
    await patchInstallConfig(install.installedAppId, {
        [BLUEPRINT_KEY]: blueprint.id,
        [MAP_KEY]: input.mapId ?? "",
        [RELEASE_KEY]: env.get("VERSION") ?? ""
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
    const env = new Map(base.env.filter((entry) => entry.value.length > 0).map((entry) => [entry.key, entry.value]));
    // Minted here rather than by the install's `generated` path, which produces 48
    // hex characters - a length ARK refuses at the enablecheats prompt, leaving the
    // server's own admin locked out of it. Same shape as the join password, which
    // is a shape the game demonstrably takes.
    for (const [key, value] of Object.entries(arkServerEnv(input, ports, mintJoinPassword()))) env.set(key, value);

    const install = await installApp(
        ownerId,
        actorId,
        { ...base, name: input.name, env: [...env.entries()].map(([key, value]) => ({ key, value })) },
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
    return commonVersions(requiredProjects(blueprint, crossplay, map?.projects), loader ?? undefined);
}

/** The newest release a blueprint can run on, or null when nothing constrains it. */
export async function blueprintVersion(blueprint: GameBlueprint, crossplay = false): Promise<string | null> {
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
    for (const project of requiredProjects(blueprint, crossplay, map?.projects)) projects.add(project);
    return formatProjectList([...projects]);
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
        [...GAME_BLUEPRINTS.flatMap((blueprint) => blueprint.projects), ...CROSSPLAY_PROJECTS, ...RETIRED_PROJECTS]
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
    return promptedEnvVars(manifest).filter((field) => ["TYPE", "VERSION"].includes(field.key));
}
