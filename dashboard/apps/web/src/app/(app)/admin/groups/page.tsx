/**
 * Groups admin. Lists every group with the first page of its members and lets an
 * admin create groups and manage membership. Policies are bound to groups on the
 * Policies page; here we only shape who belongs to what.
 *
 * Neither the rosters nor the people who could join them are read whole: a group
 * can be everybody a deployment serves, so each arrives with a page and a count,
 * its dialog reads the rest as it is scrolled, and somebody to add is found by
 * name.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { GroupsAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function GroupsAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader title={t("groups.page.title")} description={t("groups.page.description")} />
            <GroupsAdminLoader revision={Date.now()} />
        </>
    );
}
