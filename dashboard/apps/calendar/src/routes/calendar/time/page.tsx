/**
 * Calendar's Time area: alarms, timers, the stopwatch and the world clock.
 *
 * The server draws the header and the tabs' frame; the lists are read in the
 * browser, painting what this tab kept the last time first.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { TimeView } from "../../../screens/clock/time-view";

export const dynamic = "force-dynamic";

export default async function CalendarTimePage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <PageHeader
                title={t("time.title")}
                description={t("time.description")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar">
                            <ArrowLeft />
                            {t("screen.backToCalendar")}
                        </Link>
                    </Button>
                }
            />
            <TimeView />
        </div>
    );
}
