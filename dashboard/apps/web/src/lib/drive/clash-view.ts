/**
 * A clash, told to the person who has to decide it - with "Replace" (or, for a
 * folder, "Merge") offered only when the same check the write makes would let
 * it through, so the dialog never offers something the server then refuses.
 */

import { hasTrash } from "@/lib/trash-service";
import { NameConflictError, type Clash } from "@/lib/drive/name-conflicts";
import type { ClashView, ReplaceBlocked } from "@/lib/drive/conflict-types";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";

/** Why `userId` may not write over the item at `existingPath`, or null when they may. */
export async function replaceRefusal(
    userId: string,
    connectionId: string,
    existingPath: string
): Promise<ReplaceBlocked | null> {
    try {
        await authorizeDrive(userId, connectionId, existingPath, "write");
        return null;
    } catch (caught) {
        if (caught instanceof DriveLockedError) return "locked";
        if (caught instanceof DriveAccessError) return "permission";
        throw caught;
    }
}

/**
 * The write-time half of `replaceRefusal`, for the item actually about to be
 * replaced: a folder, or a file behind a lock, comes back as a clash to ask
 * about again; a file the person may not change is a refusal.
 */
export async function assertMayReplace(
    userId: string,
    connectionId: string,
    clash: Clash
): Promise<void> {
    if (clash.existingKind === "dir") throw new NameConflictError(clash);
    const refusal = await replaceRefusal(userId, connectionId, clash.existingPath);
    if (refusal === "permission") throw new DriveAccessError();
    if (refusal === "locked") throw new NameConflictError(clash);
}

/**
 * The view of one clash. `path` is the arrival's path relative to `base`, the
 * folder it was sent to, which is how the screen knows it. `merge` says whether
 * a folder arriving onto a folder may be merged into it (an upload) or not (a
 * move or copy, which keeps both instead). `refusal` answers `replaceRefusal`
 * for the item there; pass one from `drivePathRefusal` when viewing many clashes.
 */
export async function clashView(
    userId: string,
    connectionId: string,
    base: string,
    clash: Clash,
    incomingKind: "file" | "dir",
    merge = true,
    refusal: (existingPath: string) => Promise<ReplaceBlocked | null> = (existingPath) =>
        replaceRefusal(userId, connectionId, existingPath)
): Promise<ClashView> {
    const blocked: ReplaceBlocked | null =
        clash.existingKind !== incomingKind
            ? "kind"
            : incomingKind === "dir" && !merge
              ? "merge"
              : await refusal(clash.existingPath);
    return {
        path:
            base && clash.path.startsWith(`${base}/`)
                ? clash.path.slice(base.length + 1)
                : clash.path,
        incomingKind,
        existingName: clash.existingName,
        existingKind: clash.existingKind,
        canReplace: blocked === null,
        replaceBlocked: blocked,
        recoverable: hasTrash(connectionId)
    };
}
