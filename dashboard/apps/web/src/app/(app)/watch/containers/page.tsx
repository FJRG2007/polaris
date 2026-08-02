import { PageHeader } from "@polaris/ui";
import { WatchCardGrid } from "../watch-cards";
import { requirePermission } from "@/lib/session";
import { getWatchOverview } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

export default async function WatchContainersPage() {
    const user = await requirePermission("deploy.read");
    const overview = await getWatchOverview(user.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title="Containers"
                description="Every container on every reachable server, read live from its daemon."
            />
            <WatchCardGrid cards={overview.containers} empty="No containers on any reachable server." />
        </div>
    );
}
