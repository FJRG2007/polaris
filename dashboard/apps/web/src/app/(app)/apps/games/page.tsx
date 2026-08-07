/**
 * Game servers: every server this owner runs, of any edition, with a way to make
 * another. The rows are rendered from the install records the page already has,
 * and the live parts (who is playing, whether it is answering) arrive from the
 * page's own API - so opening it never waits on a container.
 */

import { GamesView } from "./games-view";
import { requirePermission } from "@/lib/session";
import { editionOf } from "@/lib/apps/minecraft/service";
import { listInstalledApps } from "@/lib/apps/install-service";
import { appHasCapability, findApp } from "@/lib/apps/catalog";

export const dynamic = "force-dynamic";

export default async function GameServersPage() {
    const user = await requirePermission("games.read");
    const installs = await listInstalledApps(user.id);
    const servers = installs
        .filter((install) => {
            const manifest = findApp(install.catalogId);
            return manifest ? appHasCapability(manifest, "game-server") : false;
        })
        .map((install) => ({
            id: install.id,
            name: install.name,
            catalogId: install.catalogId,
            catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
            edition: editionOf(install.catalogId),
            status: install.status
        }));
    return <GamesView servers={servers} />;
}
