/**
 * Roles admin. The answer to "what can a member actually do" - a question that
 * had no screen before this one, because the seeded roles were only ever a
 * constant in the source.
 */

import { PageHeader } from "@polaris/ui";
import { RolesAdminLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function RolesAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader title={t("roles.page.title")} description={t("roles.page.description")} />
            <RolesAdminLoader revision={Date.now()} />
        </>
    );
}
