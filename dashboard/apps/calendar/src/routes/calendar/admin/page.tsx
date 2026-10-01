/**
 * The Calendar's settings for everybody on this Polaris. Anybody with the
 * Calendar may read them; only an administrator changes them, and the screen
 * says so rather than hiding it.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { InstanceView } from "../../../screens/admin/instance-view";

export const dynamic = "force-dynamic";

export default async function CalendarAdminPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <PageHeader
                title={t("instancePage.title")}
                description={t("instancePage.description")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar/settings">
                            <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
                            {t("instancePage.back")}
                        </Link>
                    </Button>
                }
            />
            <InstanceView />
        </div>
    );
}
