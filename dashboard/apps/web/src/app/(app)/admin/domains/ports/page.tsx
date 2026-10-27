/**
 * Ports (/admin/domains/ports): the ports game servers and calls need open on the
 * router, the policy that hands them out, and the router steps to open them.
 * Admin-only.
 *
 * Awaits nothing but the admin check: each card knocks on its ports, after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { CallPortsCard } from "@/app/(app)/admin/domains/call-ports-card";
import { GamePortsCard } from "@/app/(app)/admin/domains/game-ports-card";

export const dynamic = "force-dynamic";

export default async function PortsPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col">
            <PageHeader
                title={t("domains.pages.ports.title")}
                description={t("domains.pages.ports.description")}
            />
            {/* Each card draws nothing when nothing on this server needs it, so
                the note below stands in when both are empty. */}
            <div className="peer flex w-full flex-col gap-6 empty:hidden">
                <GamePortsCard />
                <CallPortsCard />
            </div>
            <p className="hidden text-sm text-muted-foreground peer-empty:block">
                {t("domains.pages.ports.empty")}
            </p>
        </div>
    );
}
