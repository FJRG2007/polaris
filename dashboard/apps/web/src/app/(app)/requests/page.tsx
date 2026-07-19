/**
 * "Requests" page: the current user's drop points (file requests). Server
 * component that loads the owner's requests and hands them to the client view for
 * revocation. The link itself is not shown - only its hash is stored, so the URL
 * exists solely at creation time; revoking is the control offered afterwards.
 */

import { requireUser } from "@/lib/session";
import { listFileRequestsForOwner } from "@/lib/file-request-service";
import { RequestsView, type RequestRow } from "./requests-view";

export const dynamic = "force-dynamic";

export default async function RequestsPage() {
    const user = await requireUser();
    const requests = await listFileRequestsForOwner(user.id);
    const rows: RequestRow[] = requests.map((request) => ({
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
            <div>
                <h1 className="text-lg font-semibold">Drop points</h1>
                <p className="text-sm text-muted-foreground">
                    Links that collect uploads into your folders. Create one from the Files page.
                </p>
            </div>
            <RequestsView requests={rows} />
        </div>
    );
}
