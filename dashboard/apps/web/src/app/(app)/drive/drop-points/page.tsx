/**
 * "Drop points" page (/drive/drop-points): the current user's drop points (file
 * requests). Server component that loads the owner's drop points and hands them
 * to the client list. Each row links to its detail page, where the owner can see
 * collected files, edit the config, view activity, reopen, or clone it. The link
 * itself is only shown once at creation, so it is never listed here.
 */

import { requireUser } from "@/lib/session";
import { listFileRequestsForOwner } from "@/lib/file-request-service";
import { listConnections } from "@/lib/storage-service";
import { NewDropPointButton } from "./new-drop-point-button";
import { DropPointsView, type DropPointRow } from "./drop-points-view";

export const dynamic = "force-dynamic";

export default async function DropPointsPage() {
    const user = await requireUser();
    const [requests, connections] = await Promise.all([
        listFileRequestsForOwner(user.id),
        listConnections(user.id)
    ]);
    const rows: DropPointRow[] = requests.map((request) => ({
        id: request.id,
        title: request.title,
        destinationPath: request.destinationPath,
        connectionName: request.destination.name,
        requireLogin: request.requireLogin,
        maxFiles: request.maxFiles,
        submissionCount: request._count.submissions,
        expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
        revokedAt: request.revokedAt ? request.revokedAt.toISOString() : null,
        createdAt: request.createdAt.toISOString()
    }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">Drop points</h1>
                    <p className="text-sm text-muted-foreground">
                        Links that collect uploads into your folders.
                    </p>
                </div>
                <NewDropPointButton connections={connections.map((row) => ({ id: row.id, name: row.name }))} />
            </div>
            <DropPointsView requests={rows} />
        </div>
    );
}
