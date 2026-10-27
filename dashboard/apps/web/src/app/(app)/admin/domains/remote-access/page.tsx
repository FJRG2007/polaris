/**
 * Remote access (/admin/domains/remote-access): every way in from outside that is
 * not a forwarded port - the relay, a Cloudflare tunnel, Tailscale - and the carrier
 * NAT check that decides whether one is needed. Admin-only.
 *
 * Awaits nothing but the admin check: each card reads its own state, after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { TailscaleCard } from "@/app/(app)/admin/domains/tailscale-card";
import { BackupAccessCard } from "@/app/(app)/admin/domains/backup-access-card";

export const dynamic = "force-dynamic";

export default async function RemoteAccessPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col">
            <PageHeader
                title={t("domains.pages.remoteAccess.title")}
                description={t("domains.pages.remoteAccess.description")}
            />
            <div className="flex w-full flex-col gap-6">
                <BackupAccessCard />
                <TailscaleCard />
            </div>
        </div>
    );
}
