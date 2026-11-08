import { Badge, PageHeader } from "@polaris/ui";
import { SessionShareButton } from "./share-button";
import { notFound } from "next/navigation";
import { SessionDetail } from "./session-detail";
import { requirePermission, sessionCan } from "@/lib/session";
import { getSession, sessionEvents, sharedSession } from "@/lib/agents/session-service";
import { historyPage } from "@/lib/agents/session-history";
import { getTranslations } from "@/lib/i18n/request";
import { readSessionWaiting } from "@/lib/agents/agent-notices";
import { pendingPermission } from "@/lib/agents/session-permissions";

export const dynamic = "force-dynamic";

export default async function AgentSessionPage({
    params
}: {
    params: Promise<{ sessionId: string }>;
}) {
    const { sessionId } = await params;
    const user = await requirePermission("agents.read");
    const owned = await getSession(sessionId, user.id);
    // Somebody it was shared with (`agents.session`) reads it and nothing more.
    const session = owned ?? (await sharedSession(sessionId, user.id));
    if (!session) notFound();
    const shared = owned === null;
    const t = await getTranslations("agents");

    // Opening the session is reading what the bell said about it.
    const [events, history, , canControl, permission] = await Promise.all([
        sessionEvents(sessionId),
        historyPage(sessionId),
        readSessionWaiting(sessionId, user.id),
        shared ? false : sessionCan(user, "agents.manage"),
        shared ? null : pendingPermission(sessionId)
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
                        ? t("pages.sessionOn", {
                              repo: session.repoFullName,
                              branch: session.branch
                          })
                        : t("pages.sessionWorkspace")
                }
                actions={
                    shared ? (
                        <Badge variant="neutral">{t("session.sharedWithYou")}</Badge>
                    ) : (
                        <SessionShareButton sessionId={session.id} title={session.title} />
                    )
                }
            />
            <SessionDetail
                session={session}
                events={events}
                history={history}
                canControl={canControl}
                permission={canControl ? permission : null}
                shared={shared}
            />
        </>
    );
}
