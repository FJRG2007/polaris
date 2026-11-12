"use server";

import { requireAdmin } from "@/lib/session";
import { terminalSessionCap } from "@/lib/terminal-session-cap";
import { getLegalContact, publicUrls } from "@/lib/legal/service";

/** The public pages and the contact written on them. */
export async function loadSettingsAdminAction() {
    await requireAdmin();
    const [contact, publicPages] = await Promise.all([getLegalContact(), publicUrls()]);
    return { contact: contact ?? "", publicPages };
}

/** The terminal session cap, a region of its own. */
export async function loadSettingsCardsAction() {
    await requireAdmin();
    return { terminalCap: await terminalSessionCap() };
}
