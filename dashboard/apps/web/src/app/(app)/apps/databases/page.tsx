/**
 * The database browser (/apps/databases).
 *
 * The server hands over nothing but the frame. Every connection this screen
 * lists, and every row it draws, is fetched by the client that keeps it live -
 * so the header and the shell are on screen before anything has been asked for,
 * and a database that is slow to answer slows down one panel rather than the
 * navigation.
 *
 * Authorization happens in the actions, and again per connection: an id in the
 * address is a request, not a permission.
 */

import { PageHeader } from "@polaris/ui";
import { DatabasesView } from "./databases-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DatabasesPage() {
    await requirePermission("deploy.read");

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <PageHeader
                title="Databases"
                description="Browse and query your databases - the ones Polaris runs and the ones it does not."
            />
            <DatabasesView />
        </div>
    );
}
