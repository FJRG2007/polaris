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
import { commonVersions, knownUnsupported, wantsLatest } from "@/lib/apps/minecraft/blueprint-version";
import { DEFAULT_BIOME, DEFAULT_LEVEL_TYPE, levelTypeEnv, seedEnvKey } from "@/lib/apps/minecraft/world";
import { formatProjectList, loaderForType, parseProjectList, projectSlug } from "@/lib/apps/minecraft/modrinth";
import type {
    CreateArkServerInput,
    CreateGameServerInput,
    CreateMinecraftServerInput
} from "@/lib/apps/games-schema";
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

/** What decides the game a Minecraft server plays and the map it plays it on.
 *  The same answers whether the server is being created or being reset to them. */
export interface MinecraftShape {
    readonly blueprintId: string;
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
 */
export async function minecraftShapeEnv(
    edition: "java" | "bedrock",
    blueprint: GameBlueprint,
    shape: MinecraftShape,
    current: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
    const env = new Map(current);
    const versions = await blueprintVersions(blueprint, shape.crossplay, shape.software).catch(() => []);
    const asked = (shape.version ?? "").trim();
    if (!wantsLatest(asked) && knownUnsupported(versions, asked)) {
        throw new Error(
            `${blueprint.name} has nothing built for Minecraft ${asked}. The newest it runs on is ${versions[0]}.`
        );
    }
    env.set("VERSION", wantsLatest(asked) ? (versions[0] ?? "LATEST") : asked);

    // The seed and the shape of the world only ever apply to one that does not
    // exist yet, which is what both callers are about to generate. Both are
    // written every time, blank included: a value left over from the last world
    // would quietly generate the previous one under the new one's name.
    env.set(seedEnvKey(edition), shape.seed?.trim() ?? "");
    for (const [key, value] of Object.entries(
        levelTypeEnv(
            edition,
            shape.levelType ?? blueprint.levelType ?? DEFAULT_LEVEL_TYPE,
            shape.biome ?? DEFAULT_BIOME
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
        env.set("MODRINTH_PROJECTS", projectList(blueprint, env.get("MODRINTH_PROJECTS"), shape.crossplay));
    }
    for (const [key, value] of Object.entries(blueprint.env ?? {})) env.set(key, value);
    return env;
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
    input: CreateMinecraftServerInput
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

    // Which game this server was built to play, so its own page can say what that
    // game still needs of it and a reset can start from what it is now.
    await patchInstallConfig(install.installedAppId, { [BLUEPRINT_KEY]: blueprint.id });

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
        memoryMb: expectedArkMemoryMb(input.concurrentPlayers)
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
    software?: string
): Promise<string[]> {
    // Asked about the software the plugins will actually be loaded into, because
    // that is what decides whether a build for a release exists at all.
    const loader = loaderForType(blueprint.software ?? software ?? "PAPER");
    return commonVersions(requiredProjects(blueprint, crossplay), loader ?? undefined);
}

/** The newest release a blueprint can run on, or null when nothing constrains it. */
export async function blueprintVersion(blueprint: GameBlueprint, crossplay = false): Promise<string | null> {
    return (await blueprintVersions(blueprint, crossplay))[0] ?? null;
}

/** The blueprint's plugins on top of the protection every server gets, plus the
 *  crossplay pair when Bedrock players are meant to be able to join. */
function projectList(blueprint: GameBlueprint, current: string | undefined, crossplay: boolean): string {
    const projects = new Set(parseProjectList(current ?? ""));
    for (const project of blueprint.projects) projects.add(project);
    if (crossplay) for (const project of CROSSPLAY_PROJECTS) projects.add(project);
    return formatProjectList([...projects]);
}

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
export function withoutBlueprintProjects(current: string | undefined): string {
    const owned = new Set(
        [...GAME_BLUEPRINTS.flatMap((blueprint) => blueprint.projects), ...CROSSPLAY_PROJECTS]
            .map(projectSlug)
            .filter((slug): slug is string => slug !== null)
            .map((slug) => slug.toLowerCase())
    );
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
