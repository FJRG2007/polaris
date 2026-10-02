/**
 * The calendar's settings. The frame is drawn here; the settings are read in
 * the browser, so the page is on screen before they arrive.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { SettingsView } from "../../../screens/settings-view";
import { AccountsSection } from "../../../screens/accounts/accounts-section";

export const dynamic = "force-dynamic";

export default async function CalendarSettingsPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <PageHeader
                title={t("settingsPage.title")}
                description={t("settingsPage.description")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar">
                            <ArrowLeft />
                            {t("screen.backToCalendar")}
                        </Link>
                    </Button>
                }
            />
            <div className="flex flex-col gap-4">
                <AccountsSection />
                <SettingsView />
            </div>
        </div>
    );
}
