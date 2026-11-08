"use server";

import { requireAdmin } from "@/lib/session";
import { getUpdateSource } from "@/lib/update-source";
import { seasonsAllowed } from "@/lib/seasonal-service";
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

/** The seasonal themes switch and the terminal session cap, a region of their own. */
export async function loadSettingsCardsAction() {
    await requireAdmin();
    const [seasons, terminalCap] = await Promise.all([seasonsAllowed(), terminalSessionCap()]);
    return { seasons, terminalCap };
}
