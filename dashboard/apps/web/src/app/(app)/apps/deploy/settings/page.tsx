/**
 * Deploy's own settings for the open shelf (/apps/deploy/settings): what holds
 * for every project the person, or the organization, owns. Each project's own
 * settings live under the project.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { RecycleBinSettings } from "../recycle-bin-settings";
import { openShelfBinPolicy } from "@/lib/deploy/recycle-bin-access";

export const dynamic = "force-dynamic";

export default async function DeploySettingsPage() {
    const user = await requirePermission("deploy.read");
    const [t, view] = await Promise.all([
        getTranslations("deploySafety"),
        openShelfBinPolicy(user)
    ]);
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <Link
                href="/apps/deploy"
                className="mb-3 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" />
                {t("binSettings.back")}
            </Link>
            <PageHeader
                title={t("binSettings.pageTitle")}
                description={
                    view.orgName
                        ? t("binSettings.orgScope", { org: view.orgName })
                        : t("binSettings.personalScope")
                }
            />
            <RecycleBinSettings initial={view.policy} lock={view.lock} orgName={view.orgName} />
        </div>
    );
}
