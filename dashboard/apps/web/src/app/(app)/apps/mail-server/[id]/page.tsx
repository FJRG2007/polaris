/**
 * One mail server (/apps/mail-server/<id>): setup as it runs, its health, and
 * everything on it. The server row is resolved here only for the permission;
 * every panel loads its own data after the first paint.
 *
 * With the app not installed there is no server to show, and a link to one is
 * answered with the install rather than a 404.
 */

import { z } from "zod";
import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { ServerView } from "./server-view";
import { requireServer } from "@/lib/mail-server/access";
import { MailServerInstallState } from "../install-state";
import { requirePermission, sessionCan } from "@/lib/session";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function MailServerDetailPage({
    params
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requirePermission("mailserver.manage");
    const { id } = await params;
    if (!(await adoptMailServerApp())) {
        const t = await getTranslations("mailServer");
        return (
            <div className="mx-auto flex w-full max-w-5xl flex-col">
                <PageHeader
                    title={t("page.title")}
                    description={t("page.description")}
                />
                <MailServerInstallState canInstall={await sessionCan(user, "deploy.manage")} />
            </div>
        );
    }
    if (!z.string().uuid().safeParse(id).success) notFound();
    const server = await requireServer({ id: user.id, isAdmin: user.isAdmin }, id).catch(
        () => null
    );
    if (!server) notFound();
    return (
        <ServerView
            serverId={server.id}
            hostname={server.hostname}
            seed={{
                hostname: server.hostname,
                primaryDomain: server.primaryDomain,
                status: server.status
            }}
        />
    );
}
