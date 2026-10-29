import type { ShareRow } from "./shared-links-view";
import type { listSharesForOwner } from "@/lib/share-service";
import { parseStringList, readLinkGuards } from "@/lib/link-guards";

type StoredShare = Awaited<ReturnType<typeof listSharesForOwner>>[number];

/** A stored link as the shared-links rows draw it - the page that lists every
 *  link and the share dialog that lists one item's read it the same way. */
export function toShareRow(share: StoredShare): ShareRow {
    return {
        id: share.id,
        path: share.path,
        kind: share.kind,
        connectionId: share.connectionId,
        connectionName: share.connection.name,
        allowUpload: share.allowUpload,
        allowRename: share.allowRename,
        allowDelete: share.allowDelete,
        allowCreateFolder: share.allowCreateFolder,
        allowOverwrite: share.allowOverwrite,
        allowDownload: share.allowDownload,
        allowPreview: share.allowPreview,
        allowedCidrs: parseStringList(share.allowedCidrs),
        allowedCountries: parseStringList(share.allowedCountries),
        allowedContinents: parseStringList(share.allowedContinents),
        hasPassword: share.passwordHash !== null,
        guards: readLinkGuards(share),
        maxDownloads: share.maxDownloads,
        downloadCount: share.downloadCount,
        expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
        revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
        createdAt: share.createdAt.toISOString(),
        canReveal: share.encryptedToken !== null
    };
}
