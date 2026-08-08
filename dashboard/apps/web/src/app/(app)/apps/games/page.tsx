/**
 * Game servers: every server this owner runs, of any edition, with a way to make
 * another. The rows are rendered from the install records the page already has,
 * and the live parts (who is playing, whether it is answering) arrive from the
 * page's own API - so opening it never waits on a container.
 */

import { GamesView } from "./games-view";
import { findApp } from "@/lib/apps/catalog";
import { editionOf } from "@/lib/apps/minecraft/service";
import { isGameServerApp } from "@/lib/apps/games-service";
import { listInstalledApps } from "@/lib/apps/install-service";
import { requirePermission, userHasManage } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function GameServersPage() {
    const user = await requirePermission("games.read");
    const [installs, canManage] = await Promise.all([
        listInstalledApps(user.id),
        userHasManage(user, "games.manage")
    ]);
    // The manager is an installed app of its own; without it there is nothing to
    // manage, and the page offers to install it instead of pretending otherwise.
    const managerInstalled = installs.some((install) => install.catalogId === "minecraft-manager");
    const servers = installs
        .filter((install) => isGameServerApp(install.catalogId))
        .map((install) => ({
            id: install.id,
            name: install.name,
            catalogId: install.catalogId,
            catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
            edition: editionOf(install.catalogId),
            applicationId: install.applicationId,
            status: install.status
        }));
    return <GamesView servers={servers} managerInstalled={managerInstalled} canManage={canManage} />;
}
