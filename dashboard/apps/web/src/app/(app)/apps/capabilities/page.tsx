/**
 * Capabilities (/apps/capabilities): everything Polaris does for the things you
 * deploy, and where each is done. A static page - the list is code - so the only
 * thing read is which of the linked screens this reader may open.
 */

import { CapabilitiesView } from "./capabilities-view";
import { requirePermission, sessionCan } from "@/lib/session";
import { CAPABILITY_GROUPS } from "@/lib/deploy/capabilities";

export const dynamic = "force-dynamic";

export default async function CapabilitiesPage() {
    const user = await requirePermission("deploy.read");
    const needed = [
        ...new Set(
            CAPABILITY_GROUPS.flatMap((group) => group.items.flatMap((item) => item.needs ?? []))
        )
    ];
    const held = new Set(
        (
            await Promise.all(
                needed.map(async (permission) =>
                    (await sessionCan(user, permission)) ? permission : null
                )
            )
        ).filter((permission) => permission !== null)
    );
    const groups = CAPABILITY_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => ({
            ...item,
            open: (!item.needs || held.has(item.needs)) && (!item.adminOnly || user.isAdmin)
        }))
    }));
    return <CapabilitiesView groups={groups} />;
}
