/**
 * The signature each mailbox signs with.
 *
 * Per mailbox, because a work signature and a personal one are not the same
 * thing, and putting one on both is the mistake this screen exists to prevent.
 */

import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { SignatureView } from "./signature-view";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { scopeOrgIdFor } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

export default async function MailSignaturePage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id, await scopeOrgIdFor(user.id));
    if (accounts.length === 0) return <NoMailboxes what="A signature" />;
    return <SignatureView accounts={accounts} />;
}
