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
import { getTranslations } from "@/lib/i18n/request";
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
    const t = await getTranslations("mail");

    return (
        <MailListPage
            route={{
                narrow: { labelId },
                words: {
                    title: label.name,
                    emptyTitle: t("routes.labelEmptyTitle", { name: label.name }),
                    emptyBody: t("routes.labelEmptyBody")
                },
                context: {
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
