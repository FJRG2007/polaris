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

import { requireUser } from "@/lib/session";
import { ScheduleView } from "./schedule-view";
import { scheduleSettingsOf } from "@/lib/presence-schedule-service";

export const dynamic = "force-dynamic";

export default async function StatusSchedulePage() {
    const session = await requireUser();
    const settings = await scheduleSettingsOf(session.id);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Status schedule</h1>
                <p className="text-sm text-muted-foreground">
                    Hours you are away, busy, or not shown at all, repeated every week. A schedule
                    takes over when it starts, and anything you pick while one is running is yours
                    until it ends.
                </p>
            </div>
            <ScheduleView
                schedules={settings.schedules}
                timeZone={settings.timeZone}
                pinned={settings.pinned}
            />
        </div>
    );
}
