/**
 * Deploy's own settings for the open shelf (/apps/deploy/settings): what holds
 * for every project the person, or the organization, owns. Each project's own
 * settings live under the project.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn, PageHeader, settingType } from "@polaris/ui";
import { requirePermission, userHasManage } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { RecycleBinSettings } from "../recycle-bin-settings";
import { NetworkIsolationCard } from "../network-isolation-card";
import { openShelfBinPolicy } from "@/lib/deploy/recycle-bin-access";
import { reviewNetworkIsolation } from "@/lib/deploy/network-isolation";

export const dynamic = "force-dynamic";

export default async function DeploySettingsPage() {
    const user = await requirePermission("deploy.read");
    const [t, view, isolation, canManage] = await Promise.all([
        getTranslations("deploySafety"),
        openShelfBinPolicy(user),
        // The offer is a nicety: a failed read leaves the page as it was.
        reviewNetworkIsolation(user.id).catch((error) => {
            console.error("polaris: could not review network isolation:", error);
            return null;
        }),
        userHasManage(user, "deploy.manage")
    ]);
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <Link data-swipe-back
                href="/apps/deploy"
                className={cn(settingType.body, "mb-3 inline-flex w-fit items-center gap-1.5 text-muted-foreground hover:text-foreground")}
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
            <div className="flex flex-col gap-4">
                {isolation && <NetworkIsolationCard review={isolation} canManage={canManage} />}
                <RecycleBinSettings initial={view.policy} lock={view.lock} orgName={view.orgName} />
            </div>
        </div>
    );
}
