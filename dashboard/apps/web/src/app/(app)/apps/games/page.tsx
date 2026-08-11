/**
 * Game servers: every server this person runs or was given access to, of any
 * edition, with a way to make another. The rows are rendered from the install
 * records the page already has, and the live parts (who is playing, whether it is
 * answering) arrive from the page's own API - so opening it never waits on a
 * container.
 *
 * What each row offers is decided per server, not once for the page. Somebody can
 * run one of these and only be helping with another, and the table has to say so
 * rather than showing a Stop button that the action behind it would refuse.
 */

import { GamesView } from "./games-view";
import { findApp } from "@/lib/apps/catalog";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { isGameServerApp } from "@/lib/apps/games-service";
import { adoptGameServersApp } from "@/lib/apps/game-install";
import { listInstalledApps } from "@/lib/apps/install-service";
import { requirePermissionAny, userHasManage } from "@/lib/session";
import { gamePermissionsFor, reachableInstallIds } from "@/lib/apps/install-access";

export const dynamic = "force-dynamic";

export default async function GameServersPage() {
    // Anywhere at all: an account invited to one server holds no instance-wide
    // games grant, and turning it away here would leave it with a page it can open
    // only from a link somebody sends it.
    const user = await requirePermissionAny("games.read");
    const [granted, canCreate] = await Promise.all([
        reachableInstallIds(user, "games.read"),
        // Creating a server is instance-wide. Being invited to help run one is not
        // an offer to start more.
        userHasManage(user, "games.manage")
    ]);
    // One app turns this page on, whatever games end up being played on it. An
    // instance that still has the per-game managers it was built with is adopted
    // here, which is the first place its owner would notice either way.
    const installed = await adoptGameServersApp(user.id);
    const installs = await listInstalledApps(user.id, granted);
    const servers = await Promise.all(
        installs
            .filter((install) => isGameServerApp(install.catalogId))
            .map(async (install) => {
                const held = await gamePermissionsFor(user, install.id);
                return {
                    id: install.id,
                    name: install.name,
                    catalogId: install.catalogId,
                    catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
                    game: gameOfServer(install.catalogId)?.id ?? null,
                    applicationId: install.applicationId,
                    status: install.status,
                    canManage: held.includes("games.manage"),
                    // Deleting stays with whoever created it. "Manage this server"
                    // was never an offer to take it off somebody.
                    canRemove: install.ownerId === user.id || user.isAdmin
                };
            })
    );
    return <GamesView servers={servers} installed={installed !== null} canCreate={canCreate} />;
}
