/**
 * One text drop point (/drive/drop-points/text/[id]): what it has collected, and
 * the rules it collects under.
 *
 * What arrived is a snippet like any other, so each row opens in Snippets rather
 * than being shown a second way here.
 */

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { parseStringList } from "@/lib/link-guards";
import { listSnippetsForRequest } from "@/lib/snippet-service";
import { getTextRequestForOwner } from "@/lib/text-request-service";
import { TextDropPointDetail, type CollectedRow } from "./text-drop-point-detail";

export const dynamic = "force-dynamic";

export default async function TextDropPointPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await requirePermission("requests.create");
    const request = await getTextRequestForOwner(user.id, id);
    if (!request) notFound();

    const collected = await listSnippetsForRequest(user.id, id);
    const rows: CollectedRow[] = collected.map((snippet) => ({
        id: snippet.id,
        title: snippet.title,
        sealed: snippet.clientSealed,
        at: snippet.createdAt.toISOString(),
        // Their name or their handle. Never the address they sign in with:
        // whoever runs a drop point is not owed it by everybody who uses one.
        from:
            snippet.submittedBy?.name ||
            (snippet.submittedBy?.username ? `@${snippet.submittedBy.username}` : null),
        size: snippet.files.reduce((total, file) => total + file.size, 0)
    }));

    return (
        <TextDropPointDetail
            request={{
                id: request.id,
                title: request.title,
                instructions: request.instructions,
                requireLogin: request.requireLogin,
                allowSealed: request.allowSealed,
                allowedUsers: parseStringList(request.allowedUsers),
                allowedCidrs: parseStringList(request.allowedCidrs),
                allowedCountries: parseStringList(request.allowedCountries),
                allowedContinents: parseStringList(request.allowedContinents),
                maxLength: request.maxLength,
                maxSubmissions: request.maxSubmissions,
                hasPassword: request.passwordHash !== null,
                startsAt: request.startsAt ? request.startsAt.toISOString() : null,
                expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
                revokedAt: request.revokedAt ? request.revokedAt.toISOString() : null,
                submissionCount: request._count.submissions
            }}
            collected={rows}
        />
    );
}
