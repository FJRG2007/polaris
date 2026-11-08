"use server";

import { requireAdmin } from "@/lib/session";
import { getUpdateSource } from "@/lib/update-source";
import { seasonPreviewFor } from "@/lib/seasonal-preview";
import { seasonCalendar, seasonsAllowed } from "@/lib/seasonal-service";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";
import { terminalSessionCap } from "@/lib/terminal-session-cap";
import { getLegalContact, publicUrls } from "@/lib/legal/service";

/** The update policy and source, and the public pages and contact. */
export async function loadSettingsAdminAction() {
    await requireAdmin();
    const [policy, source, contact, publicPages] = await Promise.all([
        getAutoUpdatePolicy(),
        getUpdateSource(),
        getLegalContact(),
        publicUrls()
    ]);
    return { policy, source, contact: contact ?? "", publicPages };
}

/** The seasonal themes - the switch, the calendar and this session's preview -
 *  and the terminal session cap, a region of their own. */
export async function loadSettingsCardsAction() {
    const user = await requireAdmin();
    const [seasons, calendar, preview, terminalCap] = await Promise.all([
        seasonsAllowed(),
        seasonCalendar(),
        seasonPreviewFor(user.sessionId),
        terminalSessionCap()
    ]);
    return { seasons, calendar, preview, terminalCap };
}
