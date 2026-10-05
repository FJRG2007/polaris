/**
 * Filters: what happens to a message before anybody looks at it.
 *
 * Per mailbox, because the folders a rule can file into belong to one server.
 * Each filter is an automation, edited in the same editor as Places'.
 */

import { RulesView } from "./rules-view";
import { forwardTargets, listRulesFor } from "@/lib/mailbox/rules";
import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { listFolders } from "@/lib/mailbox/views";
import { listLabels } from "@/lib/mailbox/labels";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { mailShelfFor } from "@/lib/mailbox/shelf";

export const dynamic = "force-dynamic";

export default async function MailRulesPage() {
    const user = await requirePermission("mail.use");
    const shelfOrgId = await mailShelfFor(user.id);
    const accounts = await listAccountViews(user.id, shelfOrgId);
    if (accounts.length === 0) return <NoMailboxes what="rules" />;

    // Every mailbox's rules in one read, beside the folders and labels.
    const [folders, labels, rules, targets] = await Promise.all([
        listFolders(user.id, shelfOrgId),
        listLabels(user.id),
        listRulesFor(accounts.map((account) => account.id)),
        forwardTargets(user.id)
    ]);

    return (
        <RulesView
            accounts={accounts}
            folders={folders}
            labels={labels}
            rules={rules}
            forwardTargets={targets}
        />
    );
}
