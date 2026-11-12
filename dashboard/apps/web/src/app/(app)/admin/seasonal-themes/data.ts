"use server";

import { requireAdmin } from "@/lib/session";
import { seasonPreviewFor } from "@/lib/seasonal-preview";
import { seasonCalendar, seasonsAllowed } from "@/lib/seasonal-service";

/** The seasonal themes: the switch, the calendar and this session's preview. */
export async function loadSeasonalAdminAction() {
    const user = await requireAdmin();
    const [seasons, calendar, preview] = await Promise.all([
        seasonsAllowed(),
        seasonCalendar(),
        seasonPreviewFor(user.sessionId)
    ]);
    return { seasons, calendar, preview };
}
