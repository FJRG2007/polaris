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
import { applyAllowList, ARK_CATALOG_ID } from "@/lib/apps/ark/service";
import { findGame, type GameDefinition } from "@/lib/apps/games-catalog";
import { arkServerEnv, expectedArkMemoryMb } from "@/lib/apps/ark/config";
import { newestCommonVersion, wantsLatest } from "@/lib/apps/minecraft/blueprint-version";
import { DEFAULT_BIOME, DEFAULT_LEVEL_TYPE, levelTypeEnv, seedEnvKey } from "@/lib/apps/minecraft/world";
import type {
    CreateArkServerInput,
    CreateGameServerInput,
    CreateMinecraftServerInput
} from "@/lib/apps/games-schema";
import {
    CROSSPLAY_PROJECTS,
    findBlueprint,
    formatMemory,
    recommendedMemoryMb,
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
    const blueprint = findBlueprint(input.blueprintId);
    if (!blueprint) throw new Error("Unknown blueprint");
    if (!blueprint.editions.includes(input.edition)) throw new Error("That blueprint is not available for this edition");

    const memoryMb = recommendedMemoryMb(input.concurrentPlayers, blueprint.weight);
    const base = defaultInstallInput(manifest, input.serverId);
    const env = new Map(base.env.map((entry) => [entry.key, entry.value]));

    // What the operator chose, then what the blueprint insists on: a blueprint
    // that needs Paper is not a suggestion, it is what its plugins load into.
    // A blueprint is a promise about the game this server plays, and its plugins
    // keep it. Left on LATEST, one whose plugin has no build for the newest
    // release installs nothing, warns into a log nobody reads, and hands back an
    // ordinary survival server - so the version the blueprint can actually run on
    // is pinned before anything is created. Only when the operator asked for
    // whatever is newest: a version they typed is their decision.
    const pinned = wantsLatest(input.version) ? await blueprintVersion(blueprint) : null;
    env.set("VERSION", pinned ?? input.version ?? "LATEST");
    env.set("MAX_PLAYERS", String(input.maxPlayers));
    // The seed only ever applies to a world that does not exist yet, which is
    // exactly what this is creating. Left unset it is a random world, and the
    // manager can start another one from a seed later without losing this map.
    if (input.seed) env.set(seedEnvKey(input.edition), input.seed);
    // The shape of the world, which like the seed only ever applies to one that
    // does not exist yet.
    for (const [key, value] of Object.entries(
        levelTypeEnv(input.edition, input.levelType ?? DEFAULT_LEVEL_TYPE, input.biome ?? DEFAULT_BIOME)
    )) {
        env.set(key, value);
    }
    // Only the Java image runs a JVM to give a heap to.
    if (input.edition === "java") {
        env.set("MEMORY", formatMemory(memoryMb));
        env.set("TYPE", blueprint.software ?? input.software ?? "PAPER");
    }
    for (const [key, value] of Object.entries(blueprint.env ?? {})) env.set(key, value);

    // Who the server lets in, decided before it boots rather than left to a list
    // that starts enforced and empty. Last over the blueprint, because no blueprint
    // is allowed to produce a server nobody can join.
    for (const [key, value] of Object.entries(joinAccess(input.edition, input.ownerPlayer).env)) {
        env.set(key, value);
    }

    if (input.edition === "java") {
        env.set("MODRINTH_PROJECTS", projectList(blueprint, env.get("MODRINTH_PROJECTS"), input.crossplay));
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
    const env = new Map(base.env.map((entry) => [entry.key, entry.value]));
    for (const [key, value] of Object.entries(arkServerEnv(input, ports))) env.set(key, value);

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
 * The newest Minecraft release a blueprint's own plugins all support.
 *
 * Only the blueprint's projects decide it. The protection every server gets is
 * deliberately not counted: those carry "?" too, and letting an anticheat that
 * has not been rebuilt yet hold every new server back a release would be a worse
 * failure than the one this exists to fix.
 */
export async function blueprintVersion(blueprint: GameBlueprint): Promise<string | null> {
    return blueprint.projects.length === 0 ? null : newestCommonVersion(blueprint.projects);
}

/** The blueprint's plugins on top of the protection every server gets, plus the
 *  crossplay pair when Bedrock players are meant to be able to join. */
function projectList(blueprint: GameBlueprint, current: string | undefined, crossplay: boolean): string {
    const projects = new Set(
        (current ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
    );
    for (const project of blueprint.projects) projects.add(project);
    if (crossplay) for (const project of CROSSPLAY_PROJECTS) projects.add(project);
    return [...projects].join(",");
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
