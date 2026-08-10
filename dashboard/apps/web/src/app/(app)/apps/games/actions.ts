"use server";

/**
 * What the Minecraft manager does. Creating a server is the one action with any
 * weight to it, and it is deliberately the only place that decides what a server
 * is made of - the dialog asks, this authorizes and records, and games-create
 * turns the answers into an install.
 */

import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { clientIp } from "@/lib/request-context";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { clearResourceGrants } from "@polaris/auth";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { clearQueue } from "@/lib/apps/minecraft/queue-service";
import { installApp, uninstallApp } from "@/lib/apps/install-service";
import { flushWorldForStop } from "@/lib/apps/minecraft/world-service";
import { findGame, GAMES, type GameId } from "@/lib/apps/games-catalog";
import { clearSnapshots } from "@/lib/apps/minecraft/inventory-service";
import { blueprintVersion, createGameServer } from "@/lib/apps/games-create";
import { listGameMachines, type GameMachine } from "@/lib/apps/games-service";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { createGameServerSchema, type CreateGameServerInput } from "@/lib/apps/games-schema";
import { installRef, requireGameServer, requireGameServerOwner } from "@/lib/apps/install-access";
import { GAME_BLUEPRINTS, recommendedMemoryMb, formatMemory } from "@/lib/apps/minecraft/blueprints";

export interface GameSetup {
    /** Machines a server can run on, with what each has left. */
    readonly machines: GameMachine[];
    /** What a server's name ends in, per game (".mc.example.com"), so the dialog
     *  can show the address before anything exists. Null with no domain. */
    readonly domainSuffixes: Readonly<Record<GameId, string | null>>;
    /** The games this Polaris can create a server of right now - the ones whose
     *  manager is installed. The rest are a trip to the marketplace, not a choice
     *  the dialog can offer and then fail. */
    readonly games: readonly GameId[];
    /** The address this operator is on right now, offered as the one their own
     *  player is registered to - it is where they would connect from too. */
    readonly yourAddress: string | null;
}

/** Everything the create dialog needs that only the server knows. */
export async function gameSetupAction(): Promise<GameSetup> {
    const user = await requirePermission("games.manage");
    const [machines, suffixes, games, yourAddress] = await Promise.all([
        listGameMachines(user.id),
        Promise.all(GAMES.map((game) => gameDomainSuffix(game.domainLabel).catch(() => null))),
        installedGameIds(user.id),
        clientIp()
    ]);
    return {
        machines,
        domainSuffixes: Object.fromEntries(GAMES.map((game, index) => [game.id, suffixes[index] ?? null])) as Record<
            GameId,
            string | null
        >,
        games,
        yourAddress: yourAddress ?? null
    };
}

/** The games whose manager this person has installed. */
async function installedGameIds(ownerId: string): Promise<GameId[]> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { catalogId: true }
    });
    return GAMES.filter((game) => installs.some((install) => install.catalogId === game.managerCatalogId)).map(
        (game) => game.id
    );
}

/** What memory a server for this many players would be given, so the dialog can
 *  say it before anything is created. */
export async function suggestedMemoryAction(concurrentPlayers: number, blueprintId: string): Promise<string> {
    await requirePermission("games.read");
    const blueprint = GAME_BLUEPRINTS.find((entry) => entry.id === blueprintId);
    return formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
}

/**
 * The Minecraft release a blueprint's plugins can run on, for the dialog to say
 * before anything is created.
 *
 * Worth showing rather than doing quietly: a blueprint pinning an older release
 * is a real consequence - the clients that join have to match it - and finding
 * out afterwards, from the version field on a server that is already built, is
 * how somebody ends up deleting it and trying again.
 */
export async function blueprintVersionAction(blueprintId: string): Promise<{ version: string | null }> {
    await requirePermission("games.read");
    const blueprint = GAME_BLUEPRINTS.find((entry) => entry.id === blueprintId);
    if (!blueprint) return { version: null };
    return { version: await blueprintVersion(blueprint).catch(() => null) };
}

/** Create a server. Returns its installed-app id so the page can open it. */
export async function createGameServerAction(
    input: CreateGameServerInput
): Promise<{ installedAppId?: string; hostname?: string | null; error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = createGameServerSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const created = await createGameServer(user.id, user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.create",
            targetType: "installedApp",
            targetId: created.installedAppId,
            metadata:
                parsed.data.game === "ark"
                    ? { game: "ark", map: parsed.data.map, closed: parsed.data.exclusiveJoin }
                    : { game: "minecraft", edition: parsed.data.edition, blueprint: parsed.data.blueprintId }
        });
        revalidatePath("/apps/games");
        return { installedAppId: created.installedAppId, hostname: created.hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the server" };
    }
}

/** Start or stop a server from the list, without opening it. */
export async function setGameServerRunningAction(
    installedAppId: string,
    running: boolean
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        // Written out before it goes down. A stop that does not finish gracefully
        // is killed, and what a kill costs is the last few minutes everyone played.
        if (!running) await flushWorldForStop(access.ownerId, installedAppId);
        await setApplicationRunning(access.install.applicationId, access.ownerId, running);
        await recordAudit({
            actorId: user.id,
            action: running ? "games.start" : "games.stop",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the server" };
    }
}

/** Deploy the server again, for a container that is wedged or out of date. */
export async function redeployGameServerAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        await deployApplication(access.install.applicationId, access.ownerId, user.id);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not redeploy the server" };
    }
}

/**
 * Delete a server: its container, and the install that listed it.
 *
 * Reachable from the list rather than only from the server's own page, because a
 * server that cannot be opened is exactly the one somebody needs to be rid of -
 * a failed create leaves a row whose page has nothing to render.
 */
export async function deleteGameServerAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServerOwner(installedAppId);
        await uninstallApp(access.ownerId, installedAppId);
        // The server is gone, so the access people were given to it is too. An
        // orphan grant reaches nothing, but leaving it would show up on their page
        // as access to a thing that no longer exists.
        await clearResourceGrants(installRef(installedAppId));
        // And so is everything that only described this server: the bags it was
        // keeping copies of, and the decisions still waiting for players who will
        // never join it again.
        await Promise.all([clearSnapshots(installedAppId), clearQueue(installedAppId)]);
        await recordAudit({
            actorId: user.id,
            action: "games.delete",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the server" };
    }
}

/** Add a game, from the page that needs it. The manager runs nothing: installing
 *  it is what makes this Polaris able to create servers of that game. */
export async function installManagerAction(gameId: string): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    const game = findGame(gameId);
    if (!game) return { error: "That game is not one Polaris knows" };
    try {
        const result = await installApp(user.id, user.id, {
            catalogId: game.managerCatalogId,
            name: game.name,
            serverId: "local",
            storage: [],
            env: []
        });
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: result.installedAppId
        });
        revalidatePath("/apps/games");
        revalidatePath("/apps/marketplace");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not install the manager" };
    }
}
