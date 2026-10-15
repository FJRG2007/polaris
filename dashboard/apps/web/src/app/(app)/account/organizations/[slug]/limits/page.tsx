/**
 * What this organization may hold, and how much of it is in use.
 *
 * Open to everybody on the roster; the caps are editable only by an
 * administrator of this Polaris. The heading paints with the page and the usage,
 * which takes a count per dimension, is read after it.
 */

import { LimitsView } from "./limits-view";
import { getTranslations } from "@/lib/i18n/request";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationLimitsPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug);
    const t = await getTranslations("accountOrgs");

    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">{t("quotas.title")}</h2>
                <p className="text-muted-foreground text-sm">{t("quotas.intro", { org: org.name })}</p>
            </div>
            <LimitsView orgId={org.id} canEdit={user.isAdmin} />
        </div>
    );
}
