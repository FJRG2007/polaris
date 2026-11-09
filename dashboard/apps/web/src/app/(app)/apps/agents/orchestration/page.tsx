import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { OrchestrationView } from "./orchestration-view";
import { runsOverview } from "@/lib/agents/orchestration-service";

export const dynamic = "force-dynamic";

export default async function AgentOrchestrationPage() {
    const user = await requirePermission("agents.read");
    const overview = await runsOverview(user.id);
    const t = await getTranslations("agents");

    return (
        <>
            <PageHeader
                title={t("pages.orchestrationTitle")}
                description={t("pages.orchestration")}
            />
            <OrchestrationView overview={overview} />
        </>
    );
}
