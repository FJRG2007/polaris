/** What this reader keeps to hand. Theirs alone: a star is per person, so one
 *  somebody else set never shows here. */

import { OfficeView } from "../office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeStarredPage() {
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly
            sharedOnly={false}
            title="Starred"
            description="The ones you keep coming back to."
        />
    );
}
