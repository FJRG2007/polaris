/**
 * "Trash" page: the current user's recycle bin across all connections. Loads the
 * trashed items and hands them to the client view for restore / permanent delete.
 */

import { requirePermission, sessionCan } from "@/lib/session";
import { listTrash } from "@/lib/trash-service";
import { TrashView, type TrashRow } from "./trash-view";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
    const user = await requirePermission("drive.read");
    const [items, restore, remove] = await Promise.all([
        listTrash(user.id),
        sessionCan(user, "drive.write"),
        sessionCan(user, "drive.delete")
    ]);
    const rows: TrashRow[] = items.map((item) => ({
        id: item.id,
        name: item.name,
        originalPath: item.originalPath,
        connectionId: item.connectionId,
        connectionName: item.connection.name,
        trashPath: item.trashPath,
        kind: item.kind,
        size: item.size.toString(),
        deletedAt: item.deletedAt.toISOString()
    }));

    return <TrashView items={rows} abilities={{ restore, remove }} />;
}
