import { PageHeader } from "@polaris/ui";
import { WatchCardList } from "../watch-cards";
import { requirePermission, requireUser, sessionCan } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { getWatchServers } from "@/lib/watch-overview-service";
import { lentMachineServers } from "@/lib/machines/machines-service";

export const dynamic = "force-dynamic";

/**
 * Every server this reader watches: their own, under the permission Watch asks,
 * and every server somebody lent them to watch (`place.server`), marked as
 * shared with them. A lent card opens the server in Places, the screen a lent
 * server is read on; nothing else of its owner's is reached from here.
 */
export default async function WatchServersPage() {
    const user = await requireUser();
    const t = await getTranslations("watch");
    const [canRead, lent] = await Promise.all([
        sessionCan(user, "deploy.read"),
        lentMachineServers(user.id, t("servers.sharedWithYou"))
    ]);
    // Somebody with neither gets the same refusal as before.
    if (!canRead && lent.length === 0) await requirePermission("deploy.read");
    const own = canRead ? await getWatchServers(user.id) : [];

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title={t("overview.servers")}
                description={t("servers.description")}
            />
            <WatchCardList
                cards={[...own, ...lent]}
                label={t("servers.listLabel")}
                empty="No servers yet. The machine Polaris runs on appears here once it has been sampled."
            />
        </div>
    );
}
