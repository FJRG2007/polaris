/**
 * "Shared" (/drive/shared): the things other people have given this account, and
 * the things it has given away.
 *
 * Both readings come out of the same access rules Drive has always had; what was
 * missing was anywhere to see them from the side of the person they concern. A
 * folder somebody shares with you is otherwise indistinguishable from a storage
 * that happens to be in your list, and something you shared last month is
 * invisible until you go and look at the rules on the storage it lives on.
 */

import { requirePermission } from "@/lib/session";
import { SharedItemsView } from "./shared-items-view";
import { listSharedByMe, listSharedWithMe } from "@/lib/drive-sharing";

export const dynamic = "force-dynamic";

export default async function DriveSharedPage() {
    const user = await requirePermission("drive.read");
    // Both are database reads against rows this instance owns - no storage is
    // touched - so the page can render with its answer rather than a skeleton.
    const [withMe, byMe] = await Promise.all([
        listSharedWithMe(user.id),
        listSharedByMe(user.id)
    ]);

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Shared</h1>
                <p className="text-sm text-muted-foreground">
                    What people have shared with you, and what you have shared with them.
                </p>
            </div>
            <SharedItemsView withMe={withMe} byMe={byMe} />
        </div>
    );
}
