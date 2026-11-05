/**
 * One Polaris app's administrator settings: the address the app's menu and
 * page open. A native app draws its settings here; an installable app draws
 * them among its own routes, named by `settingsAt` in its catalog entry, and
 * this sends the reader there - so every app's settings have the same address
 * whichever code draws them.
 *
 * An app every Polaris comes with (Chat) is always installed: it has no catalog
 * entry and no install row, and its settings are drawn here all the same.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { appSettingsPath, builtInHasSettings } from "@/lib/apps/app-settings";
import { ChatAdminSettings } from "./_chat/chat-settings";
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
    if (builtInHasSettings(appId)) return <BuiltInSettings appId={appId} />;
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

/** The settings of an app every Polaris comes with. Only an administrator gets
 *  here: the page asked `requireAdmin` before choosing this branch. */
async function BuiltInSettings({ appId }: { appId: string }) {
    const [t, admin] = await Promise.all([
        getTranslations("marketplace"),
        getTranslations("admin")
    ]);
    if (appId !== "chat") notFound();
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <Link
                href="/admin/apps"
                className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
            >
                <ArrowLeft className="size-4" />
                {t("polaris.title")}
            </Link>
            <PageHeader
                title={admin("chat.page.title")}
                description={admin("chat.page.description")}
            />
            <ChatAdminSettings />
        </div>
    );
}
