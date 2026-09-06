/**
 * Everything carrying one label, across every mailbox.
 *
 * A label is the one way of grouping mail here that spans mailboxes: a folder
 * belongs to one server, and "Invoices" belongs to the person. That is why the
 * rail draws labels under the mailboxes rather than inside one.
 */

import { notFound } from "next/navigation";
import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { MailListPage, type MailSearchParams } from "@/app/(app)/mail/list-page";

export const dynamic = "force-dynamic";

export default async function MailLabelPage({
    params,
    searchParams
}: {
    params: Promise<{ labelId: string }>;
    searchParams: MailSearchParams;
}) {
    const user = await requirePermission("mail.use");
    const { labelId } = await params;
    const label = await prisma.mailLabel.findFirst({
        where: { id: labelId, userId: user.id },
        select: { name: true }
    });
    if (!label) notFound();

    return (
        <MailListPage
            route={{
                narrow: { labelId },
                context: {
                    title: label.name,
                    emptyTitle: `Nothing labelled ${label.name}`,
                    emptyBody: "Put this label on a conversation and it will be collected here.",
                    canArchive: true,
                    permanentDelete: false
                }
            }}
            searchParams={searchParams}
        />
    );
}
