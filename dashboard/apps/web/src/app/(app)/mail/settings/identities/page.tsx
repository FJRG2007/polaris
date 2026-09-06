/**
 * The other addresses a mailbox may send from.
 *
 * An alias, a shared team address, a second domain on the same account. What is
 * actually allowed is the mail server's decision and it says so by refusing the
 * message, so nothing here claims to have verified anything.
 */

import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { IdentitiesView } from "./identities-view";
import { listIdentities } from "@/lib/mailbox/labels";
import { listAccountViews } from "@/lib/mailbox/accounts";

export const dynamic = "force-dynamic";

export default async function MailIdentitiesPage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id);
    if (accounts.length === 0) return <NoMailboxes what="A send-as address" />;

    const identities: Record<string, Awaited<ReturnType<typeof listIdentities>>> = {};
    for (const account of accounts) identities[account.id] = await listIdentities(user.id, account.id);
    return <IdentitiesView accounts={accounts} identities={identities} />;
}
