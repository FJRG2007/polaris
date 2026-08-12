/**
 * The Overview: where signing in lands.
 *
 * Everything the grid needs to draw itself - which cards, in what order, at what
 * size, and the links pinned above them - is resolved here, because it is one
 * column of the user row and a set of permission checks the layout has already
 * paid for. The figures inside the cards are not: those are fetched by the grid
 * once it is on screen, so the first thing somebody sees after signing in is
 * their dashboard rather than a spinner over one.
 */

import { OverviewGrid } from "./overview-grid";
import { reachableApps } from "@/lib/app-access";
import { resolveOverviewLayout } from "@polaris/core";
import { accessFor, requireUser } from "@/lib/session";
import { availableOverviewWidgets } from "@/lib/overview/catalog";
import { getOverviewPreferences } from "@/lib/overview/prefs-service";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
    const user = await requireUser();
    const access = accessFor(user);
    const [preferences, available, apps] = await Promise.all([
        getOverviewPreferences(user.id),
        availableOverviewWidgets(access),
        reachableApps(access)
    ]);

    return (
        <OverviewGrid
            name={user.name}
            isAdmin={user.isAdmin}
            preferences={preferences}
            available={available}
            layout={resolveOverviewLayout(preferences, available)}
            apps={apps.map((app) => ({
                id: app.id,
                label: app.label,
                description: app.description,
                href: app.href
            }))}
        />
    );
}
