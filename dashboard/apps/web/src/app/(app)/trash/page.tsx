/**
 * "Trash" page: the current user's recycle bin across all connections. Loads the
 * trashed items and hands them to the client view for restore / permanent delete.
 */

import { requireUser } from "@/lib/session";
import { listTrash } from "@/lib/trash-service";
import { TrashView, type TrashRow } from "./trash-view";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
    const user = await requireUser();
    const items = await listTrash(user.id);
    const rows: TrashRow[] = items.map((item) => ({
        id: item.id,
        name: item.name,
        originalPath: item.originalPath,
        connectionName: item.connection.name,
        kind: item.kind,
        size: item.size.toString(),
        deletedAt: item.deletedAt.toISOString()
    }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <TrashView items={rows} />
        </div>
    );
}
