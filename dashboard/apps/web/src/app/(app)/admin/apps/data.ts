"use server";

import { requireAdmin } from "@/lib/session";
import { adoptAppInstalls } from "@/lib/app-extensions/registry";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { storeInstalls } from "@/app/(app)/apps/marketplace/store-installs";

/**
 * The Polaris apps installed here. Older install rows are folded into each app's
 * own first: both adoptions are idempotent, so running them on every read is how
 * an instance whose operator never opened this screen still gets them, and a
 * read repeated by a second tab or a retry changes nothing.
 */
export async function loadPolarisAppsAction() {
    const user = await requireAdmin();
    await Promise.all([adoptAppInstalls(user.id), adoptMailServerApp()]);
    const { installed, canInstall } = await storeInstalls(user, "polaris");
    return { installed, canInstall, canUpdateApps: user.isAdmin };
}
