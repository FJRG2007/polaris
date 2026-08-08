/**
 * An installed app's adapted dashboard. The shell (status, lifecycle controls,
 * runtime logs) is shared; app-specific panels mount inside it keyed by the
 * catalog id (e.g. the Messaging bridge's channel panel). Apps without an adapted
 * panel fall back to the shared log view.
 *
 * One catch-all route rather than a file per screen, so a game server's console,
 * players and settings are real, linkable paths without four near-identical
 * pages - the screen is chosen from the slug.
 */

import { isGameTab } from "../tabs";
import { notFound } from "next/navigation";
import { gameContextFor } from "../game-context";
import { requirePermission } from "@/lib/session";
import { InstalledAppDashboard } from "../installed-app-dashboard";
import { getInstalledApp, getInstalledAppSettings } from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

export default async function InstalledAppPage({
    params
}: {
    params: Promise<{ id: string; tab?: string[] }>;
}) {
    const user = await requirePermission("deploy.read");
    const { id, tab } = await params;
    const app = await getInstalledApp(user.id, id);
    if (!app) notFound();
    // An unknown slug is a mistyped link, not an error worth a page of its own.
    // Only a game server has screens; anything else is its shell and nothing more.
    const slug = tab?.[0] ?? "";
    if (slug && !isGameTab(slug)) notFound();
    // What the app was deployed with, so its panel can paint its settings without
    // waiting on a request of its own. Both are detail on a page whose job is to
    // manage the install, so neither may take it down: an app that cannot be
    // described is precisely the one somebody came here to stop or remove.
    const [settings, game] = await Promise.all([
        getInstalledAppSettings(user.id, id),
        gameContextFor(app).catch(() => null)
    ]);
    return <InstalledAppDashboard app={app} settings={settings} game={game} />;
}
