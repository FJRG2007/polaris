/**
 * Mail (/mail): somebody's own mailboxes, read here.
 *
 * The layout resolves the one thing every screen inside needs and no screen
 * should fetch twice: which mailboxes this person has, what folders each of them
 * actually has on its server, the labels they have made, and how much is unread.
 * All four are small, all four are drawn on every screen, and all four change
 * together when a mailbox syncs.
 *
 * **Several mailboxes is the ordinary case, not the advanced one.** The rail
 * leads with the views that merge them - one inbox holding everything - and the
 * individual mailboxes sit under it, each with its own colour so a row in a
 * merged list says which mailbox it came from without being read. Somebody with
 * one mailbox sees the same rail with one entry under it, which costs them
 * nothing; somebody with four does not have to go and find each of them.
 */

import { MailShell } from "./mail-shell";
import { requirePermission } from "@/lib/session";
import { listIdentities, listLabels } from "@/lib/mailbox/labels";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { listFolders, unreadCounts } from "@/lib/mailbox/views";

export const dynamic = "force-dynamic";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
    const user = await requirePermission("mail.use");
    const [accounts, folders, labels, unread] = await Promise.all([
        listAccountViews(user.id),
        listFolders(user.id),
        listLabels(user.id),
        unreadCounts(user.id)
    ]);

    // The addresses each mailbox may send as, so the composer can offer them
    // without a round trip when somebody presses Write. Small, and read here
    // because the composer is mounted by the shell rather than by a screen.
    const identities = Object.fromEntries(
        await Promise.all(
            accounts.map(async (account) => [account.id, await listIdentities(user.id, account.id)] as const)
        )
    );

    return (
        <MailShell
            accounts={accounts}
            folders={folders}
            labels={labels}
            identities={identities}
            unread={unread}
            viewerName={user.name}
        >
            {children}
        </MailShell>
    );
}
