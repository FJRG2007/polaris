/** A new meeting proposal. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../../lib/i18n";
import { requireCalendarUser } from "../../../../lib/access";
import { NewProposal } from "../../../../screens/proposals/proposals-view";

export const dynamic = "force-dynamic";

export default async function NewProposalPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <PageHeader
                title={t("proposals.newTitle")}
                description={t("proposals.newDescription")}
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
            <NewProposal />
        </div>
    );
}
