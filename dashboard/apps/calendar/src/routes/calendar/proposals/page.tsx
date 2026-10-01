/** Meeting proposals: candidate times people vote on. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { ProposalsView } from "../../../screens/proposals/proposals-view";

export const dynamic = "force-dynamic";

export default async function CalendarProposalsPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            <PageHeader
                title={t("proposals.pageTitle")}
                description={t("proposals.pageDescription")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar" aria-label={t("proposals.back")} title={t("proposals.back")}>
                            <ArrowLeft />
                            <span className="hidden sm:inline">{t("proposals.back")}</span>
                        </Link>
                    </Button>
                }
            />
            <ProposalsView />
        </div>
    );
}
