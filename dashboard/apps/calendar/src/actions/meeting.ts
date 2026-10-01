"use server";

/** A Polaris meeting link for an event (Nextcloud's Talk room, Google's Meet). */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { calendarT } from "../lib/i18n";
import { CalendarRefusal } from "../lib/errors";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const input = z.object({
    title: z.string().trim().max(200),
    start: z.string().datetime({ offset: true }).nullable()
});

export async function createMeetingLinkAction(raw: unknown): Promise<Outcome<{ link: string }>> {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        const title = parsed.data.title || (await calendarT())("meeting.untitled");
        const start = parsed.data.start ? new Date(parsed.data.start) : null;
        // A meeting further ahead than chat allows is created unscheduled: the
        // link works the same, and the event carries the time.
        const scheduledAt = start && start.getTime() - Date.now() < 364 * 86_400_000 ? start : null;
        const created = await host.calendarHost.createMeetingLink(user.id, { title, scheduledAt });
        if ("refused" in created) throw new CalendarRefusal(created.refused);
        return { link: created.link };
    });
}
