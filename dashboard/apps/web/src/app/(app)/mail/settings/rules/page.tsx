/**
 * Filters: what happens to a message before anybody looks at it.
 *
 * Per mailbox, because the folders a rule can file into belong to one server.
 */

import { RulesView } from "./rules-view";
import { listRules } from "@/lib/mailbox/rules";
import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { listFolders } from "@/lib/mailbox/views";
import { listLabels } from "@/lib/mailbox/labels";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { scopeOrgIdFor } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

export default async function MailRulesPage() {
    const user = await requirePermission("mail.use");
    const shelfOrgId = await scopeOrgIdFor(user.id);
    const accounts = await listAccountViews(user.id, shelfOrgId);
    if (accounts.length === 0) return <NoMailboxes what="A filter" />;

    const [folders, labels] = await Promise.all([
        listFolders(user.id, shelfOrgId),
        listLabels(user.id)
    ]);
    const rules: Record<string, Awaited<ReturnType<typeof listRules>>> = {};
    for (const account of accounts) rules[account.id] = await listRules(user.id, account.id);

    return <RulesView accounts={accounts} folders={folders} labels={labels} rules={rules} />;
}
