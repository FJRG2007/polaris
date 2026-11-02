/** One Polaris app's administrator settings. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@polaris/ui";
import { VpnAdminSettings } from "@/app/(app)/vpn/vpn-admin-settings";
import { requireAdmin } from "@/lib/session";
import { findStoreApp } from "@/lib/apps/marketplace-store";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function PolarisAppSettingsPage({
    params
}: {
    params: Promise<{ appId: string }>;
}) {
    await requireAdmin();
    const { appId } = await params;
    const app = findStoreApp(appId);
    if (!app || appId !== "vpn") notFound();
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
