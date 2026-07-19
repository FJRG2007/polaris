/**
 * "Recent" page (/drive/recent): recently modified, created, or opened files for
 * a connection, like a file manager's recent list. Server component that resolves
 * the connections the user can read and hands them to the client view, which does
 * the (network-bound) recent lookup itself so the page paints instantly.
 */

import { requireUser } from "@/lib/session";
import { listAccessibleConnections } from "@/lib/storage-service";
import { RecentView } from "./recent-view";

export const dynamic = "force-dynamic";

export default async function RecentPage() {
    const user = await requireUser();
    const connections = (await listAccessibleConnections(user.id)).map((row) => ({ id: row.id, name: row.name }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Recent</h1>
                <p className="text-sm text-muted-foreground">
                    Files you recently opened, changed, or created.
                </p>
            </div>
            <RecentView connections={connections} />
        </div>
    );
}
