/** One meeting proposal: the votes, and choosing a date. */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../../lib/i18n";
import { uuidSchema } from "../../../../lib/schemas";
import { requireCalendarUser } from "../../../../lib/access";
import { ProposalDetail } from "../../../../screens/proposals/proposal-detail";

export const dynamic = "force-dynamic";

export default async function ProposalPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireCalendarUser();
    const { id } = await params;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) notFound();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <PageHeader
                title={t("proposals.detailTitle")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link
                            href="/calendar/proposals"
                            aria-label={t("proposals.backToList")}
                            title={t("proposals.backToList")}
                        >
                            <ArrowLeft />
                            <span className="hidden sm:inline">{t("proposals.backToList")}</span>
                        </Link>
                    </Button>
                }
            />
            <ProposalDetail proposalId={parsed.data} />
        </div>
    );
}
