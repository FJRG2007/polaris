import { PageHeader } from "@polaris/ui";
import { WatchCardList } from "../watch-cards";
import { requirePermission } from "@/lib/session";
import { getWatchServers } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

export default async function WatchServersPage() {
    const user = await requirePermission("deploy.read");
    const servers = await getWatchServers(user.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title="Servers"
                description="Load on every server Polaris can reach, sampled from the containers running on it."
            />
            <WatchCardList
                cards={servers}
                label="servers"
                empty="No servers yet. The machine Polaris runs on appears here once it has been sampled."
            />
        </div>
    );
}
