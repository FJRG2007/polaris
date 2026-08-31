import { PageHeader } from "@polaris/ui";
import { TrackersView } from "./trackers-view";
import { requirePermission } from "@/lib/session";
import { listTrackers } from "@/lib/tasks/trackers/service";

export const dynamic = "force-dynamic";

export default async function TaskTrackersPage() {
    const user = await requirePermission("tasks.manage");
    const trackers = await listTrackers(user.id);

    return (
        <>
            <PageHeader
                title="Connected trackers"
                description="Work that lives in Linear or Jira, on the board here. Statuses travel both ways, so an agent can be handed any of it."
            />
            <TrackersView trackers={trackers} />
        </>
    );
}
