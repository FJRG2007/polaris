/**
 * Where uploaded files are kept (/admin/uploads).
 */

import { PageHeader } from "@polaris/ui";
import { UploadsLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function UploadsPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        // Narrow page: three settings cards and nothing wide, so the column is
        // centred in the content area, header included, rather than left against
        // the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("uploads.title")} description={t("uploads.description")} />
            <UploadsLoader revision={Date.now()} />
        </div>
    );
}
