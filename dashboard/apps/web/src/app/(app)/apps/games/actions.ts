"use server";

/**
 * What the Minecraft manager does. Creating a server is the one action with any
 * weight to it, and it is deliberately the only place that decides what a server
 * is made of - the dialog asks, this authorizes and records, and games-create
 * turns the answers into an install.
 */

import { revalidatePath } from "next/cache";
import { clientIp } from "@/lib/request-context";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { gameHostname } from "@/lib/apps/minecraft/address";
import { blueprintVersion, createGameServer } from "@/lib/apps/games-create";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { getInstalledApp, installApp, uninstallApp } from "@/lib/apps/install-service";
import { createGameServerSchema, type CreateGameServerInput } from "@/lib/apps/games-schema";
import { isGameServerApp, listGameMachines, type GameMachine } from "@/lib/apps/games-service";
import { GAME_BLUEPRINTS, recommendedMemoryMb, formatMemory } from "@/lib/apps/minecraft/blueprints";

/** The manager itself, as the marketplace knows it. */
const MANAGER_CATALOG_ID = "minecraft-manager";

export interface GameSetup {
    /** Machines a server can run on, with what each has left. */
    readonly machines: GameMachine[];
    /** The domain servers get names under, when one is configured. */
    readonly domainExample: string | null;
    /** The address this operator is on right now, offered as the one their own
     *  player is registered to - it is where they would connect from too. */
    readonly yourAddress: string | null;
}

/** Everything the create dialog needs that only the server knows. */
export async function gameSetupAction(): Promise<GameSetup> {
    const user = await requirePermission("games.manage");
    const [machines, domainExample, yourAddress] = await Promise.all([
        listGameMachines(user.id),
        gameHostname("survival"),
        clientIp()
    ]);
    return { machines, domainExample, yourAddress: yourAddress ?? null };
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
            metadata: { edition: parsed.data.edition, blueprint: parsed.data.blueprintId }
        });
        revalidatePath("/apps/games");
        return { installedAppId: created.installedAppId, hostname: created.hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the server" };
    }
}

/**
 * One of this owner's game servers, refusing anything that is not one.
 *
 * The games grants are about game servers, so they may not be spent on an
 * arbitrary install: without this check a `games.manage` holder could stop or
 * delete the messaging bridge by passing its id to a game action.
 */
async function ownedGameServer(ownerId: string, installedAppId: string) {
    const install = await getInstalledApp(ownerId, installedAppId);
    if (!install || !isGameServerApp(install.catalogId)) throw new Error("Server not found");
    return install;
}

/** Start or stop a server from the list, without opening it. */
export async function setGameServerRunningAction(
    installedAppId: string,
    running: boolean
): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    try {
        const install = await ownedGameServer(user.id, installedAppId);
        if (!install.applicationId) throw new Error("This server has not been deployed yet");
        await setApplicationRunning(install.applicationId, user.id, running);
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
    const user = await requirePermission("games.manage");
    try {
        const install = await ownedGameServer(user.id, installedAppId);
        if (!install.applicationId) throw new Error("This server has not been deployed yet");
        await deployApplication(install.applicationId, user.id, user.id);
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
    const user = await requirePermission("games.manage");
    try {
        await ownedGameServer(user.id, installedAppId);
        await uninstallApp(user.id, installedAppId);
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

/** Install the manager, from the page that needs it. */
export async function installManagerAction(): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    try {
        const result = await installApp(user.id, user.id, {
            catalogId: MANAGER_CATALOG_ID,
            name: "Minecraft",
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
