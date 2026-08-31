import { PageHeader } from "@polaris/ui";
import { SessionsView } from "./sessions-view";
import { requirePermission } from "@/lib/session";
import { listSessions } from "@/lib/agents/session-service";

export const dynamic = "force-dynamic";

export default async function AgentSessionsPage() {
    const user = await requirePermission("agents.read");
    const sessions = await listSessions(user.id);

    return (
        <>
            <PageHeader
                title="Sessions"
                description="Agents running right now, in a branch of their own. Watch one, answer it, or send it the next thing."
            />
            <SessionsView sessions={sessions} />
        </>
    );
}
