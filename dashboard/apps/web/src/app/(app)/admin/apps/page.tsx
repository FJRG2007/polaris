/**
 * Polaris apps: the marketplace of Polaris's own apps, switched on for the whole
 * instance by an administrator, beside the ones every Polaris comes with. Other
 * developers' software stays at /apps/marketplace.
 *
 * Admin-only: an app installed here is on for everybody. `?app=<id>` opens the
 * page on that app, which is how an app's own screen sends somebody here to
 * install it; one naming another developer's app lands on the user marketplace.
 */

import { redirect } from "next/navigation";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { PolarisAppsLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";
import { DEPLOYABLE_APPS_PATH, storeScope, findStoreApp } from "@/lib/apps/marketplace-store";

export const dynamic = "force-dynamic";

/**
 * The installs, and the adoption of older install rows that has to run before
 * they are listed, are read after the paint (`data.ts`); only the redirect for a
 * deployable app is decided here, from the address and the static catalogue.
 */
export default async function PolarisAppsPage({
    searchParams
}: {
    searchParams: Promise<{ app?: string | string[] }>;
}) {
    await requireAdmin();
    const { app } = await searchParams;
    const focus = typeof app === "string" ? findStoreApp(app) : undefined;
    // A deployable app belongs on the other screen: send it there with its focus.
    if (focus && storeScope(focus) === "deployable")
        redirect(`${DEPLOYABLE_APPS_PATH}?app=${encodeURIComponent(focus.id)}`);
    const t = await getTranslations("marketplace");

    return (
        <PolarisAppsLoader
            heading={
                <PageHeader title={t("polaris.title")} description={t("polaris.description")} />
            }
            initialQuery={focus?.name ?? ""}
            revision={Date.now()}
        />
    );
}
