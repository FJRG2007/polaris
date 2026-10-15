import { PageHeader } from "@polaris/ui";
import { RegistriesView } from "./registries-view";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/**
 * The container registries deploys sign in to, on the open shelf: the
 * person's own, or the organization's they are working in. The heading paints
 * at once; the list is fetched by the view.
 */
export default async function RegistriesPage() {
    await requirePermission("deploy.read");
    const t = await getTranslations("deployRegistries");
    return (
        <>
            <PageHeader title={t("title")} description={t("description")} />
            <RegistriesView />
        </>
    );
}
