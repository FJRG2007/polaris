import { RunsView } from "./runs-view";
import { getTranslations } from "@/lib/i18n/request";
import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { listRunnerRuns, runFilterOptions } from "@/lib/runners/runner-runs";

export const dynamic = "force-dynamic";

/**
 * What has run on the operator's own machines.
 *
 * Both halves come from the database and neither of them asks GitHub, so the
 * screen is complete when it paints. That is deliberate rather than incidental:
 * the record of a run is written on the machine as the job starts, precisely
 * because GitHub cannot be asked afterwards.
 */
export default async function RunnerRunsPage() {
    const user = await requirePermission("system.manage");
    const [runs, options] = await Promise.all([listRunnerRuns(user.id), runFilterOptions(user.id)]);
    const t = await getTranslations("runners");

    return (
        <>
            <PageHeader
                title={t("runs.title")}
                description={t("runs.description")}
            />
            <RunsView runs={runs} pools={options.pools} targets={options.targets} />
        </>
    );
}
