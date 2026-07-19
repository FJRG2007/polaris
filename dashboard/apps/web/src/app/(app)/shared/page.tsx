/**
 * "Shared" page: the current user's outgoing share links. Server component that
 * loads the owner's shares and hands them to the client view for revocation.
 */

import { requireUser } from "@/lib/session";
import { listSharesForOwner } from "@/lib/share-service";
import { SharedView, type ShareRow } from "./shared-view";

export const dynamic = "force-dynamic";

export default async function SharedPage() {
    const user = await requireUser();
    const shares = await listSharesForOwner(user.id);
    const rows: ShareRow[] = shares.map((share) => {
        let allowedCidrs: string[] = [];
        try {
            const parsed = JSON.parse(share.allowedCidrs);
            if (Array.isArray(parsed)) allowedCidrs = parsed.filter((value): value is string => typeof value === "string");
        } catch {
            allowedCidrs = [];
        }
        return {
            id: share.id,
            path: share.path,
            kind: share.kind,
            connectionName: share.connection.name,
            allowUpload: share.allowUpload,
            allowDownload: share.allowDownload,
            allowPreview: share.allowPreview,
            allowedCidrs,
            maxDownloads: share.maxDownloads,
            downloadCount: share.downloadCount,
            expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
            revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
            createdAt: share.createdAt.toISOString(),
            canReveal: share.encryptedToken !== null
        };
    });

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Shared links</h1>
                <p className="text-sm text-muted-foreground">Links you have created and can revoke.</p>
            </div>
            <SharedView shares={rows} />
        </div>
    );
}
