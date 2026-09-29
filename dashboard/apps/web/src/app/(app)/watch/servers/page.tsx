import { PageHeader } from "@polaris/ui";
import { WatchCardList } from "../watch-cards";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { getWatchServers } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

export default async function WatchServersPage() {
    const user = await requirePermission("deploy.read");
    const t = await getTranslations("watch");
    const servers = await getWatchServers(user.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title={t("overview.servers")}
                description={t("servers.description")}
            />
            <WatchCardList
                cards={servers}
                label={t("servers.listLabel")}
                empty="No servers yet. The machine Polaris runs on appears here once it has been sampled."
            />
        </div>
    );
}
