import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { SessionDetail } from "./session-detail";
import { requirePermission } from "@/lib/session";
import { getSession, sessionEvents, sessionMessages } from "@/lib/agents/session-service";
import { getTranslations } from "@/lib/i18n/request";

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
    const t = await getTranslations("agents");

    const [events, messages] = await Promise.all([
        sessionEvents(sessionId),
        sessionMessages(sessionId)
    ]);

    return (
        <>
            <PageHeader
                title={session.title}
                // A workspace has no repository and no branch, and printing
                // " on <branch>" for a session that checked nothing out is a
                // header describing something that is not there.
                description={
                    session.repoFullName
                        ? t("pages.sessionOn", { repo: session.repoFullName, branch: session.branch })
                        : t("pages.sessionWorkspace")
                }
            />
            <SessionDetail session={session} events={events} messages={messages} />
        </>
    );
}
