/** Deleted calendars and events, until they go for good. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { TrashView } from "../../../screens/trash-view";

export const dynamic = "force-dynamic";

export default async function CalendarTrashPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            <PageHeader
                title={t("trashPage.title")}
                description={t("trashPage.description")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar">
                            <ArrowLeft />
                            {t("screen.backToCalendar")}
                        </Link>
                    </Button>
                }
            />
            <TrashView />
        </div>
    );
}
