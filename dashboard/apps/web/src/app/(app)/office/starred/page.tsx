/** What this reader keeps to hand. Theirs alone: a star is per person, so one
 *  somebody else set never shows here. */

import { OfficeView } from "../office-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeStarredPage() {
    const t = await getTranslations("office");
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly
            sharedOnly={false}
            title={t("pages.starred.title")}
            description={t("pages.starred.description")}
        />
    );
}
