/**
 * Organizations admin (/admin/organizations): whether this deployment offers
 * them at all, who may start one, and how large they may get - beside the ones
 * that already exist, so the numbers are set against something real rather than
 * guessed.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { organizationPolicy } from "@/lib/orgs/policy";
import { listOrgDirectoryPage } from "@/lib/org-directory";
import { saveOrganizationPolicyAction } from "./actions";
import { OrganizationsAdmin } from "./organizations-admin";

export const dynamic = "force-dynamic";

export default async function OrganizationsAdminPage() {
    await requireAdmin();

    const [policy, orgs, t] = await Promise.all([
        organizationPolicy(),
        listOrgDirectoryPage(),
        getTranslations("admin")
    ]);

    return (
        // Full width, like the people directory: the list of organizations is a
        // table and reads as one.
        <>
            <PageHeader
                title={t("organizations.page.title")}
                description={t("organizations.page.description")}
            />
            <OrganizationsAdmin initial={policy} save={saveOrganizationPolicyAction} first={orgs} />
        </>
    );
}
