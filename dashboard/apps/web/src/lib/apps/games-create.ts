/**
 * Creating a game server: turning what the manager asks for into an install.
 *
 * The dialog asks who the server is for, how many of them, and what game it
 * runs. Everything the image needs is worked out from that here - which template,
 * how much heap, which plugins carry the blueprint, whether Bedrock clients can
 * join a Java server - so the answer to "what did creating it actually do" lives
 * in one place rather than spread across a form.
 *
 * The address is the last step and the only one allowed to fail quietly: a server
 * whose DNS could not be written is a working server that players reach by IP,
 * which is strictly better than no server.
 */

import { prisma } from "@polaris/db";
import { availableHostPort, installApp } from "@/lib/apps/install-service";
import { promptedEnvVars, findApp } from "@/lib/apps/catalog";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import type { CreateGameServerInput } from "@/lib/apps/games-schema";
import { gameHostname, hostnameTaken, provisionGameDns } from "@/lib/apps/minecraft/address";
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
    env.set("VERSION", input.version || "LATEST");
    env.set("MAX_PLAYERS", String(input.maxPlayers));
    // Only the Java image runs a JVM to give a heap to.
    if (input.edition === "java") {
        env.set("MEMORY", formatMemory(memoryMb));
        env.set("TYPE", blueprint.software ?? input.software ?? "PAPER");
    }
    for (const [key, value] of Object.entries(blueprint.env ?? {})) env.set(key, value);

    if (input.edition === "java") {
        env.set("MODRINTH_PROJECTS", projectList(blueprint, env.get("MODRINTH_PROJECTS"), input.crossplay));
    }

    // Crossplay is Geyser listening on the Bedrock port inside the same container,
    // so that port has to be published as well - one service, two doors. Geyser's
    // own default is 19132; the host side takes the next free one.
    const extraPorts = input.crossplay
        ? [
              {
                  host: await availableHostPort(ownerId, BEDROCK_PORT),
                  container: BEDROCK_PORT,
                  protocol: "udp" as const
              }
          ]
        : undefined;

    const install = await installApp(
        ownerId,
        actorId,
        { ...base, name: input.name, env: [...env.entries()].map(([key, value]) => ({ key, value })) },
        extraPorts
    );

    const hostname = await attachHostname(ownerId, install.installedAppId, input);
    return { installedAppId: install.installedAppId, hostname };
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
 * Give the server a name on the operator's domain and record it on the install.
 * Silent when there is no domain to put it on - the server still has the address
 * it was published at.
 */
async function attachHostname(
    ownerId: string,
    installedAppId: string,
    input: CreateGameServerInput
): Promise<string | null> {
    const wanted = await gameHostname(input.name, input.subdomain);
    if (!wanted) return null;
    if (await hostnameTaken(ownerId, wanted, installedAppId)) {
        throw new Error(`${wanted} is already taken by another server - pick a different subdomain`);
    }
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { applicationId: true }
    });
    const port = install?.applicationId ? await publishedPort(install.applicationId) : null;
    if (!port) return null;
    const address = await provisionGameDns(wanted, port, input.edition);
    if (!address.hostname) return null;
    await prisma.installedApp.update({
        where: { id: installedAppId },
        data: { config: JSON.stringify({ hostname: address.hostname, portless: address.portless }) }
    });
    return address.hostname;
}

/** The host port the install pinned for this application. */
async function publishedPort(applicationId: string): Promise<number | null> {
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        return typeof config.hostPort === "number" ? config.hostPort : null;
    } catch {
        return null;
    }
}

/** The settings the create dialog shows before a world exists, for one edition. */
export function upfrontFields(catalogId: string) {
    const manifest = findApp(catalogId);
    if (!manifest) return [];
    return promptedEnvVars(manifest).filter((field) => ["TYPE", "VERSION"].includes(field.key));
}
