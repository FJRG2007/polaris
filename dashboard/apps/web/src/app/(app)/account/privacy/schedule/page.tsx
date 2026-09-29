/**
 * Status schedule (/account/privacy/schedule): the part of the week this account
 * already knows about.
 *
 * Under privacy rather than beside the other preferences, and that is where it
 * belongs: "nobody sees me between midnight and nine" is a rule about who can
 * see what, written in hours instead of in names. The picker on your own face
 * still answers "what am I right now"; this answers the half of the question
 * that repeats.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireUser } from "@/lib/session";
import { ScheduleView } from "./schedule-view";
import { scheduleSettingsOf } from "@/lib/presence-schedule-service";

export const dynamic = "force-dynamic";

export default async function StatusSchedulePage() {
    const session = await requireUser();
    const t = await getTranslations("accountPrivacy");
    const settings = await scheduleSettingsOf(session.id);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("schedule.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("schedule.page.intro")}</p>
            </div>
            <ScheduleView
                schedules={settings.schedules}
                timeZone={settings.timeZone}
                pinned={settings.pinned}
            />
        </div>
    );
}
