/**
 * A screen of a Polaris app that is not installed here.
 *
 * Not a 404: the address is right and the app is what is missing. An
 * administrator, who can install it, is taken to it in Polaris apps; anybody
 * else goes home, since there is nothing they could do about it.
 *
 * Server-only.
 */

import { redirect } from "next/navigation";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { polarisAppsHref } from "@/lib/apps/marketplace-store";
import { homePathForUser, type SessionUser } from "@/lib/session";

/** Return when `app` is installed; otherwise leave for where it can be. */
export async function requireInstalledApp(app: string, user: SessionUser): Promise<void> {
    if (await isAppInstalled(app)) return;
    redirect(user.isAdmin ? polarisAppsHref(app) : await homePathForUser(user));
}
