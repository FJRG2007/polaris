/**
 * What each mailbox lets a message do.
 *
 * Per mailbox rather than per person, on purpose: somebody can want every
 * picture blocked on the address their bank writes to and none of it blocked on
 * the one they read newsletters in, and a single instance-wide switch would make
 * them choose.
 */

import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { PrivacyView } from "./privacy-view";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { listTrustedSenders } from "@/lib/mailbox/reading";

export const dynamic = "force-dynamic";

export default async function MailPrivacyPage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id);
    if (accounts.length === 0) return <NoMailboxes what="Privacy" />;

    const trusted: Record<string, string[]> = {};
    for (const account of accounts) trusted[account.id] = await listTrustedSenders(account.id);
    return <PrivacyView accounts={accounts} trusted={trusted} />;
}
