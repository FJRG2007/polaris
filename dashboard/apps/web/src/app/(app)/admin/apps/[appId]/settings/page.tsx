/**
 * One Polaris app's administrator settings: the address the app's menu and
 * page open. A native app draws its settings here; an installable app draws
 * them among its own routes, named by `settingsAt` in its catalog entry, and
 * this sends the reader there - so every app's settings have the same address
 * whichever code draws them.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { PageHeader } from "@polaris/ui";
import { VpnAdminSettings } from "@/app/(app)/vpn/vpn-admin-settings";
import { requireAdmin } from "@/lib/session";
import { hasAppInstall } from "@/app/(app)/apps/marketplace/store-installs";
import { findStoreApp } from "@/lib/apps/marketplace-store";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function PolarisAppSettingsPage({
    params
}: {
    params: Promise<{ appId: string }>;
}) {
    const user = await requireAdmin();
    const { appId } = await params;
    const app = findStoreApp(appId);
    if (!app?.settingsAt) notFound();
    if (!(await hasAppInstall(user, app.id))) redirect(`/admin/apps/${encodeURIComponent(app.id)}`);
    if (app.settingsAt !== appSettingsPath(app.id)) redirect(app.settingsAt);
    if (app.id !== "vpn") notFound();
    const t = await getTranslations("marketplace");
    return (
        <Messages namespaces={["vpn"]}>
            <div className="flex min-w-0 flex-col gap-4">
                <Link
                    href={`/admin/apps/${app.id}`}
                    className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
                >
                    <ArrowLeft className="size-4" />
                    {app.name}
                </Link>
                <PageHeader title={t("detail.settings")} />
                <VpnAdminSettings />
            </div>
        </Messages>
    );
}
