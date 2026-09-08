/**
 * Office (/office): everything somebody has made, most recently opened first.
 *
 * The landing screen is the recent list rather than a chooser, for the same
 * reason Mail lands on the merged inbox: people come back to something far more
 * often than they start something, and the way to start is a button on the
 * screen they were coming to anyway.
 */

import { OfficeView } from "./office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficePage() {
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title="Office"
            description="Documents, spreadsheets, slides and diagrams - yours and the ones you were given."
        />
    );
}
