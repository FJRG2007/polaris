/**
 * One mailbox's inbox.
 *
 * Reached from the rail when somebody wants that mailbox on its own - the work
 * one during work, the personal one after it. The merged views are the default
 * for a reason, but "just this one" is the second thing anybody with several
 * mailboxes asks for, and having to filter a merged list to get it is not an
 * answer.
 */

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { ownedAccount, MailAccessError } from "@/lib/mailbox/access";
import { MailListPage, type MailSearchParams } from "@/app/(app)/mail/list-page";

export const dynamic = "force-dynamic";

export default async function MailAccountPage({
    params,
    searchParams
}: {
    params: Promise<{ accountId: string }>;
    searchParams: MailSearchParams;
}) {
    const user = await requirePermission("mail.use");
    const { accountId } = await params;
    const account = await ownedAccount(user.id, accountId).catch((caught: unknown) => {
        if (caught instanceof MailAccessError) return null;
        throw caught;
    });
    if (!account) notFound();

    return (
        <MailListPage
            route={{
                narrow: { accountId, role: "inbox" },
                context: {
                    title: account.label || account.address,
                    emptyTitle: "Nothing waiting",
                    emptyBody: `Nothing new has arrived at ${account.address}.`,
                    canArchive: true,
                    permanentDelete: false,
                    restorable: false,
                    emptyRole: "" as const
                }
            }}
            searchParams={searchParams}
        />
    );
}
