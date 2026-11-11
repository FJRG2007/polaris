/**
 * One Polaris app's administrator settings: the one address the app's menu
 * and page open. A native app draws its settings here; an installable app
 * draws them among its own routes, named by `settingsAt` in its catalog
 * entry, and they are drawn inside this page - that route answers nowhere
 * else - so every app's settings have the same address.
 *
 * An app every Polaris comes with (Chat) is always installed: it has no catalog
 * entry and no install row, and its settings are drawn here all the same.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { builtInHasSettings } from "@/lib/apps/app-settings";
import { ChatAdminSettings } from "./_chat/chat-settings";
import { PolarAdminSettings } from "./_polar/polar-settings";
import { Suspense } from "react";
import { PageHeader, Skeleton } from "@polaris/ui";
import { VpnAdminSettings } from "@/app/(app)/vpn/vpn-admin-settings";
import { requireAdmin } from "@/lib/session";
import { AppSettingsLoader } from "./loader";
import { renderAppSettings } from "@/lib/app-bundles/serve-page";
import { findStoreApp } from "@/lib/apps/marketplace-store";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function PolarisAppSettingsPage({
    params,
    searchParams
}: {
    params: Promise<{ appId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireAdmin();
    const { appId } = await params;
    if (builtInHasSettings(appId)) return <BuiltInSettings appId={appId} />;
    // The catalogue is static: an id it does not know is a real 404, decided now.
    // Whether the app has settings here at all depends on what is installed, so
    // that is decided in the region (`loader.tsx`), after the shell paints.
    const app = findStoreApp(appId);
    if (!app) notFound();
    const t = await getTranslations("marketplace");

    return (
        <Messages namespaces={["vpn"]}>
            <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
                <Link
                    href={`/admin/apps/${app.id}`}
                    className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
                >
                    <ArrowLeft className="size-4" />
                    {app.name}
                </Link>
                <PageHeader title={t("detail.settings")} />
                <AppSettingsLoader
                    appId={app.id}
                    own={
                        app.id === "vpn" ? (
                            <VpnAdminSettings />
                        ) : (
                            <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
                                <AppOwnSettings appId={app.id} searchParams={searchParams} />
                            </Suspense>
                        )
                    }
                    revision={Date.now()}
                />
            </div>
        </Messages>
    );
}

/** The settings page an installable app draws among its own routes, read after the shell paints. */
async function AppOwnSettings({
    appId,
    searchParams
}: {
    appId: string;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    return renderAppSettings(appId, searchParams);
}

async function BuiltInSettings({ appId }: { appId: string }) {
    const [t, admin] = await Promise.all([
        getTranslations("marketplace"),
        getTranslations("admin")
    ]);
    if (appId === "polar") return <PolarSettings />;
    if (appId !== "chat") notFound();
    return (
        <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4">
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

/** Polar's: the header now, the settings when they are read. */
async function PolarSettings() {
    const [t, polar] = await Promise.all([
        getTranslations("marketplace"),
        getTranslations("polar")
    ]);
    return (
        <Messages namespaces={["polar"]}>
            <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4">
                <Link
                    href="/admin/apps"
                    className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
                >
                    <ArrowLeft className="size-4" />
                    {t("polaris.title")}
                </Link>
                <PageHeader
                    title={polar("admin.code.page.title")}
                    description={polar("admin.code.page.description")}
                />
                <Suspense fallback={<Skeleton className="h-96 w-full max-w-2xl rounded-lg" />}>
                    <PolarAdminSettings />
                </Suspense>
            </div>
        </Messages>
    );
}
