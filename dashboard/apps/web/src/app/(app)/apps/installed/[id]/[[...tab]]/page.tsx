/**
 * An installed app's adapted dashboard. The shell (status, lifecycle controls,
 * runtime logs) is shared; app-specific panels mount inside it keyed by the
 * catalog id (e.g. the Messaging bridge's channel panel). Apps without an adapted
 * panel fall back to the shared log view.
 *
 * One catch-all route rather than a file per screen, so a game server's console,
 * players and settings are real, linkable paths without four near-identical
 * pages - the screen is chosen from the slug.
 *
 * What the viewer holds is resolved for THIS app rather than for the instance.
 * Somebody invited to moderate one server reaches it without holding a single
 * global grant, and somebody who holds one everywhere still does not reach a
 * server that was never theirs.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { gameContextFor } from "../game-context";
import { canOpenGameTab, isGameTab } from "../tabs";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { heldOn, resourceAccess } from "@/lib/resource-access";
import { InstalledAppDashboard } from "../installed-app-dashboard";
import { gamePermissionsFor, installRef } from "@/lib/apps/install-access";
import { getInstalledApp, getInstalledAppSettings } from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

export default async function InstalledAppPage({
    params
}: {
    params: Promise<{ id: string; tab?: string[] }>;
}) {
    const user = await requireUser();
    const { id, tab } = await params;
    // deploy.read is the weakest thing an installed app can be reached with, and a
    // game grant carries it here rather than instance-wide. A viewer with neither
    // gets the same answer as one asking about an app that does not exist.
    const access =
        (await resourceAccess(user, installRef(id), "deploy.read")) ??
        (await resourceAccess(user, installRef(id), "games.read"));
    if (!access) notFound();
    const app = await getInstalledApp(access.ownerId, id);
    if (!app) notFound();

    const held = await gamePermissionsFor(user, id);
    // Starting, stopping and redeploying are the manage grant on this server, or the
    // deploy one for an app that is not a game. Removing it is nobody's but the
    // owner's: "manage this server" was never an offer to take it away.
    const canManage =
        held.includes("games.manage") || (await heldOn(user, installRef(id), ["deploy.manage"])).length > 0;
    const canRemove = access.isOwner || user.isAdmin;
    // An unknown slug is a mistyped link, not an error worth a page of its own.
    // Only a game server has screens; anything else is its shell and nothing more.
    const slug = tab?.[0] ?? "";
    // Which game it is decides which screens exist at all: ARK has no world to
    // regenerate and no Modrinth to install from, so those slugs are not screens
    // that are merely hidden here - they are screens this server does not have.
    const gameId = gameOfServer(app.catalogId)?.id ?? null;
    if (slug && !isGameTab(slug, gameId)) notFound();
    // A screen they do not hold reads the same as one that is not there. Hiding the
    // tab is what the bar does; this is what makes the URL agree with it.
    if (slug && !canOpenGameTab(slug, held, gameId)) notFound();

    // What the app was deployed with, so its panel can paint its settings without
    // waiting on a request of its own. Both are detail on a page whose job is to
    // manage the install, so neither may take it down: an app that cannot be
    // described is precisely the one somebody came here to stop or remove.
    const [settings, game] = await Promise.all([
        getInstalledAppSettings(access.ownerId, id),
        gameContextFor(app).catch(() => null)
    ]);
    return (
        <InstalledAppDashboard
            app={app}
            settings={settings}
            game={game}
            held={held}
            canManage={canManage}
            canRemove={canRemove}
        />
    );
}
