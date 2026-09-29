/**
 * Office (/office): everything somebody has made, most recently opened first.
 *
 * The landing screen is the recent list rather than a chooser, for the same
 * reason Mail lands on the merged inbox: people come back to something far more
 * often than they start something, and the way to start is a button on the
 * screen they were coming to anyway.
 */

import { OfficeView } from "./office-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficePage() {
    const t = await getTranslations("office");
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title={t("pages.office.title")}
            description={t("pages.office.description")}
        />
    );
}
