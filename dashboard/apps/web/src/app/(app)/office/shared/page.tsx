/** What other people gave this account, rather than what it made. */

import { OfficeView } from "../office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeSharedPage() {
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly={false}
            sharedOnly
            title="Shared with me"
            description="Documents somebody handed to you, or to a team or role you are in."
        />
    );
}
