/**
 * Drop-point detail page (/drive/drop-points/[id]). Loads one drop point the
 * caller owns, its full config, and the files collected so far (which double as
 * the activity log), then hands everything to the client detail view for editing,
 * reopening, cloning, and browsing the collected files. Owner-scoped: an id the
 * caller does not own resolves to null and renders a 404.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import {
    getFileRequestForOwner,
    listSubmissionsForRequest,
    parseStringArray
} from "@/lib/file-request-service";
import { listConnections } from "@/lib/storage-service";
import { resolveUserNames } from "@/lib/drive-meta-service";
import { DropPointDetail, type DropPointConfig, type SubmissionRow } from "./drop-point-detail";

export const dynamic = "force-dynamic";

export default async function DropPointDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await requireUser();

    const request = await getFileRequestForOwner(user.id, id);
    if (!request) notFound();

    const [submissions, connections] = await Promise.all([
        listSubmissionsForRequest(user.id, id),
        listConnections(user.id)
    ]);

    const names = await resolveUserNames(
        submissions.map((row) => row.submittedByUserId).filter((value): value is string => Boolean(value))
    );

    const config: DropPointConfig = {
        id: request.id,
        title: request.title,
        instructions: request.instructions,
        connectionName: request.destination.name,
        destinationConnectionId: request.destinationConnectionId,
        destinationPath: request.destinationPath,
        requireLogin: request.requireLogin,
        hasPassword: request.passwordHash !== null,
        maxSizeBytes: request.maxSizeBytes.toString(),
        maxFiles: request.maxFiles,
        allowedExtensions: parseStringArray(request.allowedExtensions),
        allowedCidrs: parseStringArray(request.allowedCidrs),
        allowedCountries: parseStringArray(request.allowedCountries),
        allowedContinents: parseStringArray(request.allowedContinents),
        expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
        revokedAt: request.revokedAt ? request.revokedAt.toISOString() : null,
        createdAt: request.createdAt.toISOString(),
        submissionCount: request._count.submissions
    };

    const rows: SubmissionRow[] = submissions.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        size: row.size.toString(),
        status: row.status,
        at: row.at.toISOString(),
        uploader: row.submittedByUserId ? (names.get(row.submittedByUserId) ?? null) : null
    }));

    return (
        <DropPointDetail
            config={config}
            submissions={rows}
            connections={connections.map((row) => ({ id: row.id, name: row.name }))}
        />
    );
}
