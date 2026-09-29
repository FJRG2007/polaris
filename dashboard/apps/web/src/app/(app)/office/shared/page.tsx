/** What other people gave this account, rather than what it made. */

import { OfficeView } from "../office-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeSharedPage() {
    const t = await getTranslations("office");
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="live"
            kind=""
            starredOnly={false}
            sharedOnly
            title={t("pages.shared.title")}
            description={t("pages.shared.description")}
        />
    );
}
