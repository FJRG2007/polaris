/** Out of the way without being gone. Filing, not deleting. */

import { OfficeView } from "../office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeArchivePage() {
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="archived"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title="Archive"
            description="Put away, and still here."
        />
    );
}
