import { PageHeader } from "@polaris/ui";
import { WatchCardGrid } from "../watch-cards";
import { requirePermission } from "@/lib/session";
import { getWatchServices } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

export default async function WatchServicesPage() {
    const user = await requirePermission("deploy.read");
    const services = await getWatchServices(user.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title="Services"
                description="Every deployed service, with the last hour of its consumption."
            />
            <WatchCardGrid cards={services} empty="No deployed services yet." />
        </div>
    );
}
