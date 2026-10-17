/**
 * Every run on the open shelf (/automations/runs), newest first.
 */

import { RunsView } from "./runs-view";
import { PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AutomationRunsPage({
    searchParams
}: {
    searchParams: Promise<{ automation?: string }>;
}) {
    const t = await getTranslations("automations");
    const { automation } = await searchParams;
    return (
        <div className="mx-auto w-full max-w-4xl">
            <PageHeader title={t("runs.title")} description={t("runs.description")} />
            <RunsView automationId={automation ?? null} />
        </div>
    );
}
