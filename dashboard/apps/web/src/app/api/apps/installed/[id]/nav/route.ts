/**
 * What the rail is allowed to show for one installed app.
 *
 * The rail is drawn by the app shell, which sits above every installed-app screen
 * and so cannot be handed anything by them. It knows an id from the path and
 * nothing else - not what the app is called, not whether it is a game server with
 * nine screens or a bridge with one, and not which of those this reader may open.
 *
 * So it asks. An app that is not a game server answers with no screens, which
 * leaves the Apps rail where it was rather than replacing it with a list of one.
 *
 * Nothing here is authorization: every screen is enforced on its own route. This
 * exists so nobody is shown a door that is locked.
 */

import { requireUser } from "@/lib/session";
import { resourceAccess } from "@/lib/resource-access";
import { getInstalledApp } from "@/lib/apps/install-service";
import { gamePermissionsFor, installRef } from "@/lib/apps/install-access";
import { GAME_TABS, visibleGameTabs } from "@/app/(app)/apps/installed/[id]/tabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    const { id } = await context.params;
    // The same pair of grants the app's own page accepts: a game grant reaches it
    // without a global one, and neither reaches an app that was never theirs.
    const access =
        (await resourceAccess(user, installRef(id), "deploy.read")) ??
        (await resourceAccess(user, installRef(id), "games.read"));
    if (!access) return Response.json({ error: "Not found" }, { status: 404 });
    const app = await getInstalledApp(access.ownerId, id);
    if (!app) return Response.json({ error: "Not found" }, { status: 404 });

    // Only a game server has screens of its own. Everything else is its shell.
    const isGame = app.catalogId.startsWith("minecraft") && app.catalogId !== "minecraft-manager";
    const held = isGame ? await gamePermissionsFor(user, id) : [];
    const tabs = isGame ? visibleGameTabs(held).map((tab) => tab.slug) : [];
    return Response.json({
        name: app.name,
        // Ordered as the tab bar has them, whatever order the grants came back in.
        tabs: GAME_TABS.filter((tab) => tabs.includes(tab.slug)).map((tab) => tab.slug)
    });
}
