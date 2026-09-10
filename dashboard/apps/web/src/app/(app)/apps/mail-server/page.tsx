/**
 * Mail server (/apps/mail-server). The mail servers Polaris runs for you: set
 * one up on this machine or a server you enrolled, and open it to manage its
 * domains, mailboxes and records.
 *
 * The page awaits nothing past the permission check; the list loads after the
 * first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { MailServersView } from "./mail-servers-view";

export const dynamic = "force-dynamic";

export default async function MailServerPage() {
    await requirePermission("mailserver.manage");
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
            <PageHeader
                title="Mail server"
                description="Send and receive mail at your own domains, with the DNS it needs published and checked from here."
            />
            <MailServersView />
        </div>
    );
}
