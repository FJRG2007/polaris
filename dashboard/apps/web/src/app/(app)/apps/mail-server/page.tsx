/**
 * Mail server (/apps/mail-server). The mail servers Polaris runs for you: set
 * one up on this machine or a server you enrolled, and open it to manage its
 * domains, mailboxes and records.
 *
 * A marketplace app: until it is installed this screen offers the install
 * instead of the list. Past the permission and that one lookup the page awaits
 * nothing; the list loads after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { MailServersView } from "./mail-servers-view";
import { MailServerInstallState } from "./install-state";
import { requirePermission, sessionCan } from "@/lib/session";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";

export const dynamic = "force-dynamic";

export default async function MailServerPage() {
    const user = await requirePermission("mailserver.manage");
    // Adopts the install for an instance that ran a mail server before it was
    // an app, so its screens stay once its last server is removed.
    const [installed, canInstall] = await Promise.all([adoptMailServerApp(), sessionCan(user, "deploy.manage")]);
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
            <PageHeader
                title="Mail server"
                description="Send and receive mail at your own domains, with the DNS it needs published and checked from here."
            />
            {installed ? (
                <MailServersView canUninstall={canInstall} />
            ) : (
                <MailServerInstallState canInstall={canInstall} />
            )}
        </div>
    );
}
