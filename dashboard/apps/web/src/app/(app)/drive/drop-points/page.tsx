/**
 * "Drop points" page (/drive/drop-points): the links this account hands out to
 * collect things - files into a folder, and text into its snippets.
 *
 * Both kinds live here because they are one job. Server component: it loads them
 * and hands each list to its own client view. A link itself is only shown once
 * at creation and recovered on demand, so neither list carries one.
 */

import { requirePermission } from "@/lib/session";
import { listConnections } from "@/lib/storage-service";
import { NewDropPointButton } from "./new-drop-point-button";
import { listFileRequestsForOwner } from "@/lib/file-request-service";
import { listTextRequestsForOwner } from "@/lib/text-request-service";
import { NewTextDropPointButton } from "./new-text-drop-point-button";
import { DropPointsView, type DropPointRow } from "./drop-points-view";
import { TextDropPointsView, type TextDropPointRow } from "./text-drop-points-view";

export const dynamic = "force-dynamic";

export default async function DropPointsPage() {
    const user = await requirePermission("drive.read");
    const [requests, textRequests, connections] = await Promise.all([
        listFileRequestsForOwner(user.id),
        listTextRequestsForOwner(user.id),
        listConnections(user.id, { personal: true })
    ]);
    const rows: DropPointRow[] = requests.map((request) => ({
        id: request.id,
        title: request.title,
        destinationPath: request.destinationPath,
        connectionName: request.destination.name,
        requireLogin: request.requireLogin,
        maxFiles: request.maxFiles,
        submissionCount: request._count.submissions,
        startsAt: request.startsAt ? request.startsAt.toISOString() : null,
        expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
        revokedAt: request.revokedAt ? request.revokedAt.toISOString() : null,
        createdAt: request.createdAt.toISOString()
    }));
    const textRows: TextDropPointRow[] = textRequests.map((request) => ({
        id: request.id,
        title: request.title,
        requireLogin: request.requireLogin,
        maxSubmissions: request.maxSubmissions,
        submissionCount: request._count.submissions,
        startsAt: request.startsAt ? request.startsAt.toISOString() : null,
        expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
        revokedAt: request.revokedAt ? request.revokedAt.toISOString() : null,
        canReveal: request.encryptedToken !== null
    }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Drop points</h1>
                    <p className="text-sm text-muted-foreground">
                        Links that collect things for you: files into your folders, text into your
                        snippets.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <NewTextDropPointButton />
                    <NewDropPointButton
                        connections={connections.map((row) => ({ id: row.id, name: row.name }))}
                    />
                </div>
            </div>

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">Files</h2>
                <DropPointsView requests={rows} />
            </section>

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">Text</h2>
                <TextDropPointsView requests={textRows} />
            </section>
        </div>
    );
}
