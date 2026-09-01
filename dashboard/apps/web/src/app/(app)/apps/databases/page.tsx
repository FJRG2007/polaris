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

import { PAGE_FILL, PageHeader, cn } from "@polaris/ui";
import { DatabasesView } from "./databases-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DatabasesPage() {
    await requirePermission("deploy.read");

    return (
        // The screen fills the window and scrolls inside its own panes. Without
        // this the `flex-1` chain below has nothing to fill: `main` is not a
        // bounded flex parent, so the panes grew instead and the whole page
        // scrolled - which put the list of tables and the column headings off
        // the top of the window the moment anybody looked at a wide table.
        <div className={cn(PAGE_FILL, "flex flex-col")}>
            <PageHeader
                title="Databases"
                description="Browse and query your databases - the ones Polaris runs and the ones it does not."
            />
            <DatabasesView />
        </div>
    );
}
