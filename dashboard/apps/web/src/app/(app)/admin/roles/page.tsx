/**
 * Roles admin. The answer to "what can a member actually do" - a question that
 * had no screen before this one, because the seeded roles were only ever a
 * constant in the source.
 */

import { PageHeader } from "@polaris/ui";
import { listedPermissions } from "@polaris/core";
import { RolesAdmin } from "./roles-admin";
import { requireAdmin } from "@/lib/session";
import { listRoles } from "@/lib/role-service";
import { getTranslations } from "@/lib/i18n/request";
import { installedPermissionApps } from "@/lib/permission-presence";

export const dynamic = "force-dynamic";

export default async function RolesAdminPage() {
    await requireAdmin();
    const [roles, t, installed] = await Promise.all([
        listRoles(),
        getTranslations("admin"),
        installedPermissionApps()
    ]);

    return (
        <>
            <PageHeader
                title={t("roles.page.title")}
                description={t("roles.page.description")}
            />
            <RolesAdmin roles={roles} listed={listedPermissions(installed)} />
        </>
    );
}
