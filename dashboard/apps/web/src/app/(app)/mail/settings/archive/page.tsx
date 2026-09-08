/**
 * Getting mail in and out of a mailbox.
 *
 * Both halves on one screen because they are the same question asked in two
 * directions, and somebody arriving from another provider usually wants both:
 * bring the archive in, and know they could take it out again.
 */

import { ArchiveView } from "./archive-view";
import { NoMailboxes } from "../empty-accounts";
import { listFolders } from "@/lib/mailbox/views";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccountViews } from "@/lib/mailbox/accounts";

export const dynamic = "force-dynamic";

export default async function MailArchivePage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id, await scopeOrgIdFor(user.id));
    if (accounts.length === 0) return <NoMailboxes what="Import and export" />;

    return <ArchiveView accounts={accounts} folders={await listFolders(user.id)} />;
}
