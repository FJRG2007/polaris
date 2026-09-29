/** Out of the way without being gone. Filing, not deleting. */

import { OfficeView } from "../office-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeArchivePage() {
    const t = await getTranslations("office");
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="archived"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title={t("pages.archive.title")}
            description={t("pages.archive.description")}
        />
    );
}
