/** A stretch of the calendar laid out for paper. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { PrintView } from "../../../screens/print-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string | null {
    const first = Array.isArray(value) ? value[0] : value;
    return first && first.length <= 20 ? first : null;
}

export default async function CalendarPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    await requireCalendarUser();
    const t = await calendarT();
    const query = await searchParams;
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <div className="pc-no-print">
                <PageHeader
                    title={t("printPage.title")}
                    description={t("printPage.description")}
                    actions={
                        <Button asChild size="sm" variant="ghost">
                            <Link href="/calendar">
                                <ArrowLeft />
                                {t("screen.backToCalendar")}
                            </Link>
                        </Button>
                    }
                />
            </div>
            <PrintView view={one(query.view)} date={one(query.date)} />
        </div>
    );
}
