/**
 * Which of the apps that bring permissions this Polaris has installed, so the
 * permission lists (a person's capabilities, the instance and organization role
 * editors) show only what is here. One cached presence check per such app, not
 * per permission or per area.
 *
 * Server-only.
 */

import { ORG_PERMISSION_APPS, PERMISSION_APPS } from "@polaris/core";
import { isAppInstalled } from "@/lib/apps/install-presence";

/** The installed apps among those any instance or organization permission names. */
export async function installedPermissionApps(): Promise<string[]> {
    const named = [...new Set([...PERMISSION_APPS, ...ORG_PERMISSION_APPS])];
    const verdicts = await Promise.all(
        named.map(async (app) => [app, await isAppInstalled(app).catch(() => false)] as const)
    );
    return verdicts.filter(([, present]) => present).map(([app]) => app);
}
