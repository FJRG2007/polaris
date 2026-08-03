/**
 * Which apps an account can actually open, and where it lands.
 *
 * The registry says what each app costs (AppEntry.permission); this resolves that
 * against one person, once per render, and everything that lists apps - the
 * switcher, the command palette, the redirect after signing in - reads the same
 * answer. An account that holds nothing is not a broken state: a role can exist
 * purely so somebody can be identified at a share link or a drop point, and for
 * them the only place that means anything is their own account.
 *
 * Takes the capability check as an argument rather than importing it, so this
 * stays usable from a role preview (where the answer is the role's, not the
 * administrator's) without knowing anything about sessions.
 */

import type { Permission } from "@polaris/core";
import { POLARIS_APPS, type AppEntry } from "@/lib/apps";

/** Where somebody with no app at all belongs. */
export const ACCOUNT_HOME = "/account";

export interface AppAccessInput {
    isAdmin: boolean;
    can: (permission: Permission) => Promise<boolean>;
}

/** The apps this person may open, in registry order. Hidden apps (the account
 *  section) are not included: they are reached from the account menu. */
export async function reachableApps({ isAdmin, can }: AppAccessInput): Promise<AppEntry[]> {
    const decided = await Promise.all(
        POLARIS_APPS.map(async (app) => {
            if (app.hidden) return null;
            if (app.adminOnly && !isAdmin) return null;
            if (app.permission && !(await can(app.permission))) return null;
            return app;
        })
    );
    return decided.filter((app): app is AppEntry => app !== null);
}

/** The ids of the apps this person may open, for the client components that only
 *  need to filter a list they already hold. */
export async function reachableAppIds(input: AppAccessInput): Promise<string[]> {
    return (await reachableApps(input)).map((app) => app.id);
}

/**
 * Where this person goes when they ask for "home" - after signing in, from the
 * dashboard root, and when a screen turns them away. The first app they can open,
 * or their own account when they can open none.
 */
export async function homePathFor(input: AppAccessInput): Promise<string> {
    const apps = await reachableApps(input);
    return apps[0]?.href ?? ACCOUNT_HOME;
}
