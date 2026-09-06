/**
 * One folder, as its own mail server names it.
 *
 * Where somebody goes for a folder only one of their mailboxes has - the filing
 * a company mailbox came with, a rule's destination, the years of mail somebody
 * sorted by hand in another client. Nothing here renames or reshapes it: it is
 * the server's folder, under the server's name.
 */

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { ownedFolder, MailAccessError } from "@/lib/mailbox/access";
import { MailListPage, type MailSearchParams } from "@/app/(app)/mail/list-page";

export const dynamic = "force-dynamic";

export default async function MailFolderPage({
    params,
    searchParams
}: {
    params: Promise<{ folderId: string }>;
    searchParams: MailSearchParams;
}) {
    const user = await requirePermission("mail.use");
    const { folderId } = await params;
    const folder = await ownedFolder(user.id, folderId).catch((caught: unknown) => {
        if (caught instanceof MailAccessError) return null;
        throw caught;
    });
    if (!folder) notFound();

    return (
        <MailListPage
            route={{
                narrow: { folderId, accountId: folder.accountId },
                context: {
                    title: folder.name,
                    emptyTitle: `${folder.name} is empty`,
                    emptyBody: "Nothing in this folder has been synced yet, or there is nothing in it.",
                    canArchive: folder.role !== "archive",
                    permanentDelete: folder.role === "trash" || folder.role === "junk"
                }
            }}
            searchParams={searchParams}
        />
    );
}
