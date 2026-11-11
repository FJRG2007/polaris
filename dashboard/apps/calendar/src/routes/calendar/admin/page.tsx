/**
 * The Calendar's settings for everybody on this Polaris, drawn inside
 * Management > Polaris apps > Calendar > Settings
 * (`/admin/apps/calendar/settings`), the one address every app's settings
 * have; that page draws the frame and the way back. At the Calendar's own
 * `/calendar/admin` it is not found.
 */

import { notFound } from "next/navigation";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { InstanceView } from "../../../screens/admin/instance-view";

export const dynamic = "force-dynamic";

export default async function CalendarAdminPage() {
    const user = await requireCalendarUser();
    if (!user.isAdmin) notFound();
    const t = await calendarT();
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("instancePage.description")}</p>
            <InstanceView />
        </div>
    );
}
