"use server";

/**
 * Creating a game server from the Game servers page. It is the marketplace
 * install with the edition chosen up front, so a server made here and one made
 * from a marketplace card are the same thing - there is one install path, and
 * this is a shorter way into it.
 */

import { revalidatePath } from "next/cache";
import { listHosts } from "@/lib/host-service";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { installApp } from "@/lib/apps/install-service";
import { appInstallInputSchema, type AppInstallInput } from "@/lib/apps/install-schema";
import { appHasCapability, findApp, POLARIS_APP_CATALOG, isInstallable } from "@/lib/apps/catalog";

export interface GameEditionOption {
    catalogId: string;
    name: string;
    summary: string;
}

export interface GameTargetOption {
    id: string;
    name: string;
}

/** The editions a server can be created as: every installable game-server app. */
export async function listGameEditionsAction(): Promise<GameEditionOption[]> {
    await requirePermission("games.read");
    return POLARIS_APP_CATALOG.filter((app) => appHasCapability(app, "game-server") && isInstallable(app)).map(
        (app) => ({ catalogId: app.id, name: app.name, summary: app.summary })
    );
}

/** The machines a server can run on: this one, plus every connected server. */
export async function listGameTargetsAction(): Promise<GameTargetOption[]> {
    const user = await requirePermission("games.manage");
    const hosts = await listHosts(user.id);
    return [
        { id: "local", name: "Local (this server)" },
        ...hosts.map((host) => ({ id: host.id, name: host.name }))
    ];
}

/** Create a server. Returns its installed-app id so the page can open it. */
export async function createGameServerAction(
    input: AppInstallInput
): Promise<{ installedAppId?: string; error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = appInstallInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const manifest = findApp(parsed.data.catalogId);
    // This page creates game servers; anything else is installed from the
    // marketplace, where its own description and consent are shown.
    if (!manifest || !appHasCapability(manifest, "game-server")) return { error: "That is not a game server" };
    try {
        const result = await installApp(user.id, user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.create",
            targetType: "installedApp",
            targetId: result.installedAppId,
            metadata: { catalogId: parsed.data.catalogId }
        });
        revalidatePath("/apps/games");
        return { installedAppId: result.installedAppId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the server" };
    }
}
