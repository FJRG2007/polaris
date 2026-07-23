/**
 * Drop-point detail page (/drive/drop-points/[id]). Loads one drop point the
 * caller owns, its full config, the files collected so far, and the visitor
 * sessions recorded for it, then hands everything to the client detail view for
 * editing, reopening, cloning, browsing files, and seeing who connected.
 * Owner-scoped: an id the caller does not own resolves to null and renders a 404.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import {
    getFileRequestForOwner,
    listSubmissionsForRequest,
    listVisitsForRequest,
    parseStringArray
} from "@/lib/file-request-service";
import { listConnections } from "@/lib/storage-service";
import { resolveUserNames } from "@/lib/drive-meta-service";
import {
    DropPointDetail,
    type DropPointConfig,
    type SubmissionRow,
    type VisitorRow
} from "./drop-point-detail";

export const dynamic = "force-dynamic";

export default async function DropPointDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await requireUser();

    const request = await getFileRequestForOwner(user.id, id);
    if (!request) notFound();

    const [submissions, visits, connections] = await Promise.all([
        listSubmissionsForRequest(user.id, id),
        listVisitsForRequest(user.id, id),
        listConnections(user.id)
    ]);

    const userIds = [
        ...submissions.map((row) => row.submittedByUserId),
        ...visits.map((row) => row.userId)
    ].filter((value): value is string => Boolean(value));
    const names = await resolveUserNames(userIds);

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
        minSizeBytes: request.minSizeBytes !== null ? request.minSizeBytes.toString() : null,
        maxFiles: request.maxFiles,
        allowedExtensions: parseStringArray(request.allowedExtensions),
        deniedExtensions: parseStringArray(request.deniedExtensions),
        allowedCidrs: parseStringArray(request.allowedCidrs),
        allowedCountries: parseStringArray(request.allowedCountries),
        allowedContinents: parseStringArray(request.allowedContinents),
        allowedUsers: parseStringArray(request.allowedUsers),
        startsAt: request.startsAt ? request.startsAt.toISOString() : null,
        allowUploaderDelete: request.allowUploaderDelete,
        uploaderDeleteWindowSeconds: request.uploaderDeleteWindowSeconds,
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

    const visitors: VisitorRow[] = visits.map((row) => ({
        id: row.id,
        ip: row.ip,
        user: row.userId ? (names.get(row.userId) ?? null) : null,
        userAgent: row.userAgent,
        uploads: row.uploadCount,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString()
    }));

    return (
        <DropPointDetail
            config={config}
            submissions={rows}
            visitors={visitors}
            connections={connections.map((row) => ({ id: row.id, name: row.name }))}
        />
    );
}
