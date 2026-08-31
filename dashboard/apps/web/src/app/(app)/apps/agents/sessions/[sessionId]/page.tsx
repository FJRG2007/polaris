import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { SessionDetail } from "./session-detail";
import { requirePermission } from "@/lib/session";
import { getSession, sessionEvents, sessionMessages } from "@/lib/agents/session-service";

export const dynamic = "force-dynamic";

export default async function AgentSessionPage({
    params
}: {
    params: Promise<{ sessionId: string }>;
}) {
    const { sessionId } = await params;
    const user = await requirePermission("agents.read");
    const session = await getSession(sessionId, user.id);
    if (!session) notFound();

    const [events, messages] = await Promise.all([
        sessionEvents(sessionId),
        sessionMessages(sessionId)
    ]);

    return (
        <>
            <PageHeader
                title={session.title}
                description={`${session.repoFullName} on ${session.branch}`}
            />
            <SessionDetail session={session} events={events} messages={messages} />
        </>
    );
}
