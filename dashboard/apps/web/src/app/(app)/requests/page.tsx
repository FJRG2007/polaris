/**
 * "Requests" page: the current user's drop points (file requests). Server
 * component that loads the owner's requests and hands them to the client view for
 * revocation. The link itself is not shown - only its hash is stored, so the URL
 * exists solely at creation time; revoking is the control offered afterwards.
 */

import { requireUser } from "@/lib/session";
import { flaggedCounts, listFileRequestsForOwner } from "@/lib/file-request-service";
import { listConnections } from "@/lib/storage-service";
import { NewDropPointButton } from "./new-drop-point-button";
import { RequestsView, type RequestRow } from "./requests-view";

export const dynamic = "force-dynamic";

export default async function RequestsPage() {
    const user = await requireUser();
    const [requests, connections] = await Promise.all([
        listFileRequestsForOwner(user.id),
        listConnections(user.id)
    ]);
    const flagged = await flaggedCounts(requests.map((request) => request.id));
    const rows: RequestRow[] = requests.map((request) => ({
        id: request.id,
        title: request.title,
        destinationPath: request.destinationPath,
        connectionName: request.destination.name,
        requireLogin: request.requireLogin,
        maxFiles: request.maxFiles,
        submissionCount: request._count.submissions,
        flaggedCount: flagged.get(request.id) ?? 0,
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
            <RequestsView requests={rows} />
        </div>
    );
}
