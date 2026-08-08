"use server";

/**
 * What the Minecraft manager does. Creating a server is the one action with any
 * weight to it, and it is deliberately the only place that decides what a server
 * is made of - the dialog asks, this authorizes and records, and games-create
 * turns the answers into an install.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { installApp } from "@/lib/apps/install-service";
import { createGameServer } from "@/lib/apps/games-create";
import { gameHostname } from "@/lib/apps/minecraft/address";
import { listGameMachines, type GameMachine } from "@/lib/apps/games-service";
import { createGameServerSchema, type CreateGameServerInput } from "@/lib/apps/games-schema";
import { GAME_BLUEPRINTS, recommendedMemoryMb, formatMemory } from "@/lib/apps/minecraft/blueprints";

/** The manager itself, as the marketplace knows it. */
const MANAGER_CATALOG_ID = "minecraft-manager";

export interface GameSetup {
    /** Machines a server can run on, with what each has left. */
    readonly machines: GameMachine[];
    /** The domain servers get names under, when one is configured. */
    readonly domainExample: string | null;
}

/** Everything the create dialog needs that only the server knows. */
export async function gameSetupAction(): Promise<GameSetup> {
    const user = await requirePermission("games.manage");
    const [machines, domainExample] = await Promise.all([listGameMachines(user.id), gameHostname("survival")]);
    return { machines, domainExample };
}

/** What memory a server for this many players would be given, so the dialog can
 *  say it before anything is created. */
export async function suggestedMemoryAction(concurrentPlayers: number, blueprintId: string): Promise<string> {
    await requirePermission("games.read");
    const blueprint = GAME_BLUEPRINTS.find((entry) => entry.id === blueprintId);
    return formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
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
