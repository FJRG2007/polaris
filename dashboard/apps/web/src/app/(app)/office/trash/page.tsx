/** On the way out. Everything here can still be put back, which is the whole
 *  reason a bin exists between deleting and gone. */

import { OfficeView } from "../office-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeTrashPage() {
    const t = await getTranslations("office");
    await requirePermission("office.use");
    return (
        <OfficeView
            shelf="trashed"
            kind=""
            starredOnly={false}
            sharedOnly={false}
            title={t("pages.trash.title")}
            description={t("pages.trash.description")}
        />
    );
}
