/**
 * Polaris' own junk filter, per mailbox.
 *
 * The screen exists as much to show what the filter has learned as to switch it
 * on and off. A classifier whose state is invisible is one nobody trusts, and
 * the two numbers on it - how many messages it has been taught and how many
 * words it knows - are the honest answer to "is this thing doing anything yet".
 */

import { JunkView } from "./junk-view";
import { NoMailboxes } from "../empty-accounts";
import { requirePermission } from "@/lib/session";
import { spamLearning } from "@/lib/mailbox/spam";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccountViews } from "@/lib/mailbox/accounts";

export const dynamic = "force-dynamic";

export default async function MailJunkPage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id, await scopeOrgIdFor(user.id));
    if (accounts.length === 0) return <NoMailboxes what="Junk" />;

    const learning: Record<string, { junk: number; good: number; words: number }> = {};
    for (const account of accounts) learning[account.id] = await spamLearning(account.id);
    return <JunkView accounts={accounts} learning={learning} />;
}
