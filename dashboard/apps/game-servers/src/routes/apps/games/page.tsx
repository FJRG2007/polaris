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

import { gameOfServer } from "@polaris/core";
import { GamesView } from "../../../screens/games-view";
import { isGameServerApp } from "../../../lib/games-service";
import { adoptGameServersApp } from "../../../lib/game-install";
import { NO_GAME_SERVER_PREFS, readGameServerPrefs } from "../../../lib/games-prefs";
import { prisma } from "@polaris/db";
import * as duplicatePlan from "../../../lib/duplicate-plan";
import { host } from "@polaris/app-host";

const { findApp } = host.appsCatalog;
const { listInstalledApps } = host.appsInstallService;
const { requirePermissionAny, userHasManage } = host.session;
const { gamePermissionsFor, reachableInstallIds } = host.appsInstallAccess;
const { readInstallConfig } = host.appsInstallConfig;

export const dynamic = "force-dynamic";

export default async function GameServersPage() {
    // Anywhere at all: an account invited to one server holds no instance-wide
    // games grant, and turning it away here would leave it with a page it can open
    // only from a link somebody sends it.
    const user = await requirePermissionAny("games.read");
    // None of these waits on another, so none waits behind another: the adoption
    // touches only the per-game manager rows, which the list below leaves out.
    const [installed, canCreate, installs] = await Promise.all([
        // One app turns this page on, whatever games end up being played on it.
        // An instance that still has the per-game managers it was built with is
        // adopted here, which is the first place its owner would notice either
        // way.
        adoptGameServersApp(user.id),
        // Creating a server is instance-wide. Being invited to help run one is
        // not an offer to start more.
        userHasManage(user, "games.manage"),
        reachableInstallIds(user, "games.read").then((granted) =>
            listInstalledApps(user.id, granted)
        )
    ]);
    const games = installs.filter((install) => isGameServerApp(install.catalogId));
    const [prefs, held, copying] = await Promise.all([
        // Where this person keeps each of them - starred, put away - read for the
        // whole list in one go. Theirs alone: the same server is one somebody else
        // may have archived, and neither of them decides that for the other.
        readGameServerPrefs(
            user.id,
            games.map((install) => install.id)
        ),
        Promise.all(games.map((install) => gamePermissionsFor(user, install.id))),
        // The copies still being made, and the ones that stopped part-way: their
        // rows say how far they got instead of being an ordinary server.
        copyStates(games.map((install) => install.id))
    ]);
    const servers = games.map((install, index) => {
        const pref = prefs.get(install.id) ?? NO_GAME_SERVER_PREFS;
        return {
            id: install.id,
            name: install.name,
            catalogId: install.catalogId,
            catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
            game: gameOfServer(install.catalogId)?.id ?? null,
            applicationId: install.applicationId,
            status: install.status,
            canManage: held[index]?.includes("games.manage") ?? false,
            // Deleting stays with whoever created it. "Manage this server"
            // was never an offer to take it off somebody.
            canRemove: install.ownerId === user.id || user.isAdmin,
            // The same rule the duplicate action enforces, so the menu never
            // offers a copy the action would refuse.
            duplicate: duplicatePlan.duplicatePermission({
                canCreate,
                isOwner: install.ownerId === user.id,
                isAdmin: user.isAdmin
            }),
            copy: copying.get(install.id) ?? null,
            favorite: pref.favorite,
            archived: pref.archived
        };
    });
    return <GamesView servers={servers} installed={installed !== null} canCreate={canCreate} />;
}

/** The copy state of each install that carries one, in one read. */
async function copyStates(
    ids: readonly string[]
): Promise<Map<string, duplicatePlan.DuplicateState>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.installedApp.findMany({
        where: { id: { in: [...ids] }, config: { contains: `"${duplicatePlan.DUPLICATE_KEY}":{` } },
        select: { id: true, config: true }
    });
    const states = new Map<string, duplicatePlan.DuplicateState>();
    for (const row of rows) {
        const state = duplicatePlan.readDuplicateState(readInstallConfig(row.config));
        if (state) states.set(row.id, state);
    }
    return states;
}
