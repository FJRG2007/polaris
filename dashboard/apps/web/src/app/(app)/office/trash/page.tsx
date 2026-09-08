/** On the way out. Everything here can still be put back, which is the whole
 *  reason a bin exists between deleting and gone. */

import { OfficeView } from "../office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeTrashPage() {
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="trashed"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title="Trash"
            description="Deleted, and not yet gone. Put something back, or delete it for good."
        />
    );
}
