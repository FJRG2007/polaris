import { PageHeader } from "@polaris/ui";
import { TrackersView } from "./trackers-view";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listTrackers } from "@/lib/tasks/trackers/service";

export const dynamic = "force-dynamic";

export default async function TaskTrackersPage() {
    const user = await requirePermission("tasks.manage");
    const trackers = await listTrackers(user.id);
    const t = await getTranslations("tasks");

    return (
        <>
            <PageHeader
                title={t("trackers.title")}
                description={t("trackers.description")}
            />
            <TrackersView trackers={trackers} />
        </>
    );
}
