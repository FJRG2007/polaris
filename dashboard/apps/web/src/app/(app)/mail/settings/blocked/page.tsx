/**
 * Everybody this mailbox is refusing.
 *
 * Its own screen rather than a section of the filters, because "who am I
 * blocking" is a question people ask, and answering it by making somebody read
 * a list of rules is answering a different question.
 */

import { BlockedView } from "./blocked-view";
import { requirePermission } from "@/lib/session";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listBlockedSenders } from "@/lib/mailbox/blocking";

export const dynamic = "force-dynamic";

export default async function MailBlockedPage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id, await scopeOrgIdFor(user.id));
    const blocked = Object.fromEntries(
        await Promise.all(
            accounts.map(
                async (account) =>
                    [account.id, await listBlockedSenders(user.id, account.id)] as const
            )
        )
    );
    return <BlockedView accounts={accounts} blocked={blocked} />;
}
