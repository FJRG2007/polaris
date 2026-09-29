import { PageHeader } from "@polaris/ui";
import { SessionsView } from "./sessions-view";
import { requirePermission } from "@/lib/session";
import { listSessions } from "@/lib/agents/session-service";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AgentSessionsPage() {
    const user = await requirePermission("agents.read");
    const sessions = await listSessions(user.id);
    const t = await getTranslations("agents");

    return (
        <>
            <PageHeader
                title={t("pages.sessionsTitle")}
                description={t("pages.sessions")}
            />
            <SessionsView sessions={sessions} />
        </>
    );
}
